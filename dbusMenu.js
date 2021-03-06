/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
// Copyright (C) 2011 Giovanni Campagna
// Copyright (C) 2013 Jonas Kuemmerlin <rgcjonas@gmail.com>
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
// 
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Signals = imports.signals;

const PopupMenu = imports.ui.popupMenu;
const Shell = imports.gi.Shell;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Util = Extension.imports.util;

//copied from libdbusmenu
const DBusMenuInterface = <interface name="com.canonical.dbusmenu">
<!-- Properties -->
		<property name="Version" type="u" access="read">
		</property>
		<property name="TextDirection" type="s" access="read">
		</property>
		<property name="Status" type="s" access="read">
		</property>
		<property name="IconThemePath" type="as" access="read">
		</property>
<!-- Functions -->
		<method name="GetLayout">
			<arg type="i" name="parentId" direction="in" />
			<arg type="i" name="recursionDepth" direction="in" />
			<arg type="as" name="propertyNames" direction="in"  />
			<arg type="u(ia{sv}av)" name="layout" direction="out" />
		</method>
		<method name="GetGroupProperties">
			<arg type="ai" name="ids" direction="in" >
			</arg>
			<arg type="as" name="propertyNames" direction="in" >
			</arg>
			<arg type="a(ia{sv})" name="properties" direction="out" >
			</arg>
		</method>
		<method name="GetProperty">
			<arg type="i" name="id" direction="in">
			</arg>
			<arg type="s" name="name" direction="in">
			</arg>
			<arg type="v" name="value" direction="out">
			</arg>
		</method>
		<method name="Event">
			<arg type="i" name="id" direction="in" >
			</arg>
			<arg type="s" name="eventId" direction="in" >
			</arg>
			<arg type="v" name="data" direction="in" >
			</arg>
			<arg type="u" name="timestamp" direction="in" >
			</arg>
		</method>
		<method name="EventGroup">
			<arg type="a(isvu)" name="events" direction="in">
			</arg>
			<arg type="ai" name="idErrors" direction="out">
			</arg>
		</method>
		<method name="AboutToShow">
			<arg type="i" name="id" direction="in">
			</arg>
			<arg type="b" name="needUpdate" direction="out">
			</arg>
		</method>
		<method name="AboutToShowGroup">
			<arg type="ai" name="ids" direction="in">
			</arg>
			<arg type="ai" name="updatesNeeded" direction="out">
			</arg>
			<arg type="ai" name="idErrors" direction="out">
			</arg>
		</method>
<!-- Signals -->
		<signal name="ItemsPropertiesUpdated">
			<arg type="a(ia{sv})" name="updatedProps" direction="out" />
			<arg type="a(ias)" name="removedProps" direction="out" />
		</signal>
		<signal name="LayoutUpdated">
			<arg type="ui" name="parent" direction="out" />
		</signal>
		<signal name="ItemActivationRequested">
			<arg type="i" name="id" direction="out" >
			</arg>
			<arg type="u" name="timestamp" direction="out" >
			</arg>
		</signal>
<!-- End of interesting stuff -->
	</interface>

const DBusMenuProxy = Gio.DBusProxy.makeProxyWrapper(DBusMenuInterface);

/**
 * Menu:
 * uses dbus to get a description of a menu
 * and then builds an equivalent St one, using PopupMenu.
 *
 * Differently from Gtk version, does not support accelators,
 * as PopupMenu has no API for these.
 *
 */
const Menu = new Lang.Class({
    Name: 'DbusMenu',
    Extends: Util.Mixin,

    _init: function(name, path, callback) {
        this.parent();
        
        //bus settings
        this._lateMixin.busName = name;
        this._lateMixin.path = path;
        
        this._lateMixin._proxy = new DBusMenuProxy(Gio.DBus.session, name, path, (function(result, error) {
        	if (callback) {
	        	log("calling callback on "+name+path);
	        	callback(this);
	        }
        }).bind(this));
    },
    
    _conserve: [
    	'open'
    ],
    
    _mixinInit: function() {
    	// compact representation of a tree
        this._children = { };
        this._parents = { '0': null };
        this._itemProperties = { '0': { } };
        this._items = { };
        
        this._proxy.connectSignal('ItemsPropertiesUpdated', Lang.bind(this, this._itemsPropertiesUpdated));
        this._proxy.connectSignal('ItemUpdated', Lang.bind(this, this._itemUpdated));
        this._proxy.connectSignal('LayoutUpdated', Lang.bind(this, this._layoutUpdated));
        this._revision = 0;
        
        // HACK: the spec mandates calling AboutToShow when opening the menu, but this
        // causes the menu to be updated, recreating the layout, destroying the actors and
        // thus immediately closing it
        // -> FIXME: rgcjonas: seems to be wrong. re-reading layout in toggle() works as expected.
        // Therefore we simulate it here
        this._proxy.AboutToShowRemote(0, Lang.bind(this, function() {
            this._readLayout(0, false);
        }));
    },
    
    _mixin: {
	    reset: function() {
	        this._readLayout(0);        
	    },

	    _readLayout: function(subtree) {
	         this._proxy.GetLayoutRemote(subtree, -1, ['id'], (function(result, error) {
	            if (error) {
	            	log(error);
	            	error.stack.split("\n").forEach(function(e) { log(e); });
	            }
	            let revision = result[0];
	            let layout = result[1];
	            if (this._revision >= revision)
	                return;
	            let root = layout;
	            function recurse(element) {
	                let id = element[0];
	                this._children[id] = [ ];
	                let child;
	                for each (child in element[2]) {
	                    let childid = child.deep_unpack()[0];
	                    this._children[id].push(childid);
	                    this._parents[childid] = id;
	                    if (!this._itemProperties[childid])
	                        this._readItem(childid);
	                    recurse.call(this, child.deep_unpack());
	                }
	            }
	            recurse.call(this, root);
	            this._revision = revision;
	            this._buildMenu(subtree);
	            this._GCItems();
	        }).bind(this));
	    },

	    _readItem: function(id) {
	        this._proxy.GetGroupPropertiesRemote([id], [], Lang.bind(this, function (result, error) { 
	            if (error) {
	                log("While reading item "+id+" on "+this.busName+this.path+": ");
	                log(error);
	                error.stack.split("\n").forEach(function(e) { log(e); });
	            } else if (!result[0][0]) {
	                //FIXME: how the hell does nm-applet manage to get us here?
	                //it doesn't seem to have any negative effects, however
	                log("While reading item "+id+" on "+this.busName+this.path+": ");
	                log("Empty result set (?)");
	                log(result);
	            } else {
	                //the unpacking algorithm is very strange...
	                var props = result[0][0][1];
	                for (var i in props) {
	                	props[i] = props[i].deep_unpack();
	                }
	                this._itemProperties[id] = props;
	                if(id == 0)
	                    this._updateRoot();
	                else
	                    this._replaceItem(id, true);
	            }
	        }));        
	    },

	    _GCItems: function() {
	        // normally, a GC employs BFS, but this is a tree
	        // so DFS is easier and faster
	        let item;
	        for each (item in this._items)
	            item._collect = true;
	        function reach(id) {
	            if (this._items[id])
	                this._items[id]._collect = false;
	            for each (let child in this._children[id])
	                reach.call(this, child);
	        }
	        for each (child in this._children[0])
	            reach.call(this, child);
	        for each (item in this._items) {
	            if (item._collect) {
	                let id = item._dbusId;
	                item.destroy();
	                delete this._itemProperties[id];
	                delete this._children[id];
	                delete this._parent[id];
	            }
	        }
	    },

	    _buildMenu: function(subtree) {
	        let menu;
	        if (subtree == 0)
	            menu = this;
	        else
	            menu = this._items[subtree].menu;
	        if (menu == null) {
	            // not a PopupMenu.PopupSubMenuMenuItem, or a destroyed one?
	            // then rebuild it
	            this._replaceItem(subtree);
	            menu = this._items[subtree].menu;
	            if (menu == null)
	                // the menu is inconsistent with itself, kill this submenu
	                return;
	        }
	        menu.removeAll();
	        for each (let child in this._children[subtree]) {
	            if (!this._itemProperties[child])
	                // we don't have the properties yet, skip...
	                continue;
	            this._items[child] = this._buildItem(child);
	            menu.addMenuItem(this._items[child]);
	            if (this._children[child].length > 0)
	                this._buildMenu(child);
	        }
	    },

	    _replaceItem: function(id, recurse) {
	        let position = 0;
	        let parent = this._parents[id];
	        if(parent != 0 && (!this._items[parent] || !this._items[parent].menu)) {
	            // parent is not ready, rebuild it
	            this._replaceItem(parent);
	        }
	        let menu;
	        if (parent == 0)
	            menu = this;
	        else
	            menu = this._items[parent].menu;
	        let siblings = this._children[this._parents[id]];
	        for (let i = 0;i < siblings.length && siblings[i] != id;++i) {
	            if (this._items[siblings[i]])
	                position++;
	        }
	        let original = this._items[id];

		    // in the first implementation, this function stole
		    // the submenu from the controlling item
		    // I don't know how feasible it would be now that submenus
		    // are inlined
	        if (original)
	            original.destroy();

	        let item = this._items[id] = this._buildItem(id);
		    let has_children = this._itemProperties[id]['children-display'] == 'submenu';
		    if (has_children && recurse)
		        this._buildMenu(id);
	        menu.addMenuItem(item, position);
	    },

	    _buildItem: function(id) {
	        let properties = this._itemProperties[id];
	        let type = properties['type'];
	        // remove all underscores not followed by another underscore
	        let label = properties['label'] || '';
	        if (label)
	            label = label.replace(/_([^_])/, '$1');
	        let icon = properties['icon-name'];
	        // FIXME: icon-data is not supported
	        let icon_data = properties['icon-data'];
	        let toggle_type = properties['toggle-type'];
	        let has_children = properties['children-display'] == 'submenu';
	        let stitem;
	        let activate = true;
	        let reactive = 'enabled' in properties ? properties['enabled'] : true;
	        let visible = 'visible' in properties ? properties['visible'] : true;
	        if (type == 'separator') {
	            // ignores label, sensitive, has_children, icon, toggle_type
	            activate = false;
	            stitem = new PopupMenu.PopupSeparatorMenuItem();
	        } else if (has_children) {
	            // ignores icon, toggle_type
	            activate = false;
	            stitem = new PopupMenu.PopupSubMenuMenuItem(label);
	            stitem._dbusOpeningId = stitem.menu.connect('opening', Lang.bind(this, function(menu) {
	                this._proxy.AboutToShowRemote(id, Lang.bind(this, function(needsRelayout) {
	                    if (needsRelayout)
	                        this._readLayout(id);
	                }));
	            }));
	        } else if (toggle_type) {
	            // ignores icon
	            let toggle_state = properties['toggle-state'];
	            if (toggle_type == 'checkmark')
	                stitem = new PopupMenu.PopupSwitchMenuItem(label, toggle_state, { reactive: reactive });
	            else if (toggle_type == 'radio') {
	                stitem = new PopupMenu.PopupMenuItem(label, { reactive: reactive });
	                stitem.setShowDot(toggle_state);
	            }
	        } else if (icon) {
	        	stitem = new PopupMenu.PopupImageMenuItem(label, icon, { reactive: reactive });
	        } else if (icon_data) {
	        	stitem = new PopupMenu.PopupMenuItem(label, { reactive: reactive });
	        	let iconActor = Util.createActorFromMemoryImage(icon_data, 24);
	        	iconActor.add_style_class_name('popup-menu-icon');
	        	stitem.addActor(iconActor, { align: St.Align.END });
	        }	            
	        else
	            stitem = new PopupMenu.PopupMenuItem(label, { reactive: reactive });
	        if (visible)
	            stitem.actor.show();
	        else
	            stitem.actor.hide();
	        if (activate) {
	            stitem._dbusActivateId = stitem.connect('activate', Lang.bind(this, this._itemActivate));
	            //stitem._dbusHoverId = stitem.connect('active-changed', Lang.bind(this, this._itemHovered));
	        }
	        stitem._dbusId = id;
	        stitem.connect('destroy', Lang.bind(this, this._itemDestroy));
	        return stitem;
	    },

	    _itemUpdated: function (proxy, id) {
	        log(this.busName + this.path + "  updating item "+id);
	        log("WARNING: this method is not specified in libdbusmenu (!?)");
	        this._readItem(id);
	    },

	    _itemsPropertiesUpdated: function (proxy, bus, [changed, removed]) {
	    	//FIXME: the array structure is weird
	    	for (var i = 0; i < changed.length; i++) {
	    		var id = changed[i][0];
	    		var properties = changed[i][1];
	    		for (var property in properties) {
	    			this._itemPropertyUpdated(proxy, id, property, properties[property].deep_unpack())
	    		}
	    	}
	    },
	    
	    _itemPropertyUpdated: function (proxy, id, property, value) {
	        if (!this._itemProperties[id]) {
	        	//we don't have any properties yet, this means we don't even deal with the item
	        	//we couldn't use the property data anyway, so we bail out here
	        	return;
	        }
	        if (!this._items[id]) {
	        	//property is updated but the item isn't even present.
	        	//we'll build the item now.
	        	return this._replaceItem(id, true);
	        }
	        this._itemProperties[id][property] = value;
	        if (id == 0) {
	            this._updateRoot();
	            return;
	        }
	        if (property == 'label')
	            this._items[id].label.text = value;
	        else if (property == 'visible') {
	            if (value)
	                this._items[id].actor.show();
	            else
	                this._items[id].actor.hide();
	        } else if (property == 'sensitive')
	            this._items[id].actor.reactive = this._items[id].actor.track_hover = value;
	        else if (property == 'enabled') {
	            let item = this._items[id];
	            if (value) {
	                if(!item._dbusActivateId)
	                    item._dbusActivateId = item.connect('activate', Lang.bind(this, this._itemActivated));
	                //if(!item._dbusHoverId)
	                //    item._dbusHoverId = item.connect('active-changed', Lang.bind(this, this._itemHovered));
	            } else {
	                if (item._dbusActivateId) {
	                    item.disconnect(item._dbusActivateId);
	                    item._dbusActivateId = 0;
	                }
	                //if (item._dbusHoverId) {
	                //    item.disconnect(item._dbusHoverId);
	                //   item._dbusHoverId = 0;
	                //}
	            }
	        } else if (property == 'toggle-state') {
	            if (this._items[id].setToggleState)
	                this._items[id].setToggleState(value);
	            else
	                this._items[id].setShowDot(value);
	        } else if (property == 'icon-name' && this._items[id].setIcon)
	            this._items[id].setIcon(value);
	        else if (this._parents[id]) // element is already on a layout
	            this._replaceItem(this._parents[id], true);
	    },

	    _layoutUpdated: function(proxy, bus, [revision, subtree]) {
	        log(this.busName + this.path + "    Layout updated for node "+subtree);
	        if (revision <= this._revision)
	            return;
	        this._readLayout(subtree);
	    },

	    _itemDestroy: function(item) {
	        delete this._items[item._dbusId];
	        if (item._dbusActivateId) {
	            item.disconnect(item._dbusActivateId);
	            item._dbusActivateId = 0;
	        }
	        if (item._dbusHoverId) {
	            item.disconnect(item._dbusHoverId);
	            item._dbusHoverId = 0;
	        }
	        if (item.menu && item._dbusOpeningId) {
	            item.menu.disconnect(item._dbusOpeningId);
	            item._dbusOpeningId = 0;
	        }
	    },

	    _itemActivate: function(item, event) {
	        // we emit clicked also for keyboard activation
	        // XXX: what is event specific data?
	        this._proxy.EventRemote(item._dbusId, 'clicked', GLib.Variant.new("s", ""), event.get_time());
	    },

	    /* FIXME: apparently this is not correct
	    _itemHovered: function(item, active) {
	        // we emit hovered also for keyboard selection
	        if (active) {
	            this._proxy.EventRemote(item._dbusId, 'hovered', '', 0);
	        }
	    },
	    */

	    _updateRoot: function() {
	        let properties = this._itemProperties[0];
	        this.title = properties['label'];
	        this.active = properties['enabled'];
	        this.visible = properties['visible'];
	        this.emit('root-changed');
	    },
	    
	    destroyDbusMenu: function() {
	    	this._GCItems();
	    	Signals._disconnectAll.apply(this._proxy);
	    	delete this._proxy;
	    },
	    
	    preOpen: function(callback) {
	    	this._proxy.AboutToShowRemote(0, Lang.bind(this, function(needUpdate) {
	            if (needUpdate) {
	            	this._readLayout(0);
	            }
	            if (callback) callback();
	        }));
	    },
	    
	    open: function(animation) {
	    	this.preOpen(Lang.bind(this, function(){
	    		this._conserved.open.call(this, animation);
	    	}));
	    }
    }
});
