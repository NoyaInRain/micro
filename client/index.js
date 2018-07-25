/*
 * micro
 * Copyright (C) 2018 micro contributors
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Lesser General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License along with this program.
 * If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Client toolkit for social micro web apps.
 */

"use strict";

micro.util.watchErrors();

micro.LIST_LIMIT = 100;
micro.SHORT_DATE_TIME_FORMAT = {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
};

/**
 * Find the first ancestor of *elem* that satisfies *predicate*.
 *
 * .. deprecated: 0.11.0
 *
 *    Use :func:`micro.keyboard.findAncestor` .
 */
micro.findAncestor = micro.keyboard.findAncestor;

/**
 * User interface of a micro app.
 *
 * At the core of the UI are pages, where any page has a corresponding (shareable and bookmarkable)
 * URL. The UI takes care of user navigation.
 *
 * .. attribute:: page
 *
 *    The current :ref:`Page`. May be ``null``.
 *
 * .. attribute:: pages
 *
 *    Subclass API: Table of available pages.
 *
 *    It is a list of objects with the attributes *url* and *page*, where *page* is the page to show
 *    if the requested URL matches the regular expression pattern *url*.
 *
 *    *page* is either the tag of a :ref:`Page` or a function. If it is a tag, the element is
 *    created and used as page.
 *
 *    If *page* is a function, it has the form *page(url)* and is responsible to prepare and return
 *    a :ref:`Page`. *url* is the requested URL. Groups captured from the URL pattern are passed as
 *    additional arguments. The function may return a promise. For convenience, if one of the
 *    following common call errors is thrown:
 *
 *    - `TypeError`: The `micro-offline-page` is shown
 *    - `NotFoundError`: The `micro-not-found-page` is shown
 *    - `PermissionError`: The `micro-forbidden-page` is shown
 *
 *    May be set by subclass in :meth:`init`. Defaults to ``[]``.
 *
 * .. attribute:: service
 *
 *    Service worker of the app, more precisely a :class:`ServiceWorkerRegistration`.
 *
 * .. attribute:: renderEvent
 *
 *    Subclass API: Table of event rendering hooks by event type. Used by the activity page to
 *    visualize :ref:`Event` s. A hook has the form *renderEvent(event)* and is responsible to
 *    render the given *event* to a :class:`Node`.
 */
micro.UI = class extends HTMLBodyElement {
    createdCallback() {
        this.page = null;
        this._progressElem = this.querySelector(".micro-ui-progress");
        this._pageSpace = this.querySelector("main .micro-ui-inside");

        this.pages = [
            {url: "^/(?:users/([^/]+)|user)/edit$", page: micro.EditUserPage.make},
            {url: "^/settings/edit$", page: micro.EditSettingsPage.make},
            {url: "^/activity$", page: micro.ActivityPage.make}
        ];

        this.renderEvent = {
            "editable-edit": event => {
                let a = document.createElement("a");
                a.classList.add("link");
                a.href = "/settings/edit";
                a.textContent = "site settings";
                let userElem = document.createElement("micro-user");
                userElem.user = event.user;
                return micro.util.formatFragment("The {settings} were edited by {user}",
                                                 {settings: a, user: userElem});
            }
        };

        window.addEventListener("error", this);
        this.addEventListener("click", this);
        window.addEventListener("popstate", this);
        this.addEventListener("user-edit", this);
        this.addEventListener("settings-edit", this);

        // Register UI as global
        window.ui = this;

        // Cancel launch if platform checks failed
        if (!micro.launch) {
            return;
        }

        micro.keyboard.enableActivatedClass();
        micro.bind.transforms.ShortcutContext = micro.keyboard.ShortcutContext;
        micro.bind.transforms.Shortcut = micro.keyboard.Shortcut;
        this.shortcutContext = new micro.keyboard.ShortcutContext(this);
        this.shortcutContext.add("J", micro.keyboard.quickNavigate.bind(null, "next"));
        this.shortcutContext.add("K", micro.keyboard.quickNavigate.bind(null, "prev"));

        this.insertBefore(
            document.importNode(this.querySelector(".micro-ui-template").content, true),
            this.querySelector("main"));
        this._data = new micro.bind.Watchable({
            settings: {title: document.title}
        });
        micro.bind.bind(this.children, this._data);

        let update = () => {
            document.querySelector('link[rel=icon][sizes="16x16"]').href =
                this._data.settings.icon_small || "";
            document.querySelector('link[rel=icon][sizes="192x192"]').href =
                this._data.settings.icon_large || "";
        };
        this._data.watch("settings", update);

        this.features = {
            es6TypedArray: "ArrayBuffer" in window,
            serviceWorkers: "serviceWorker" in navigator,
            push: "PushManager" in window
        };
        this.classList.add(
            ...Object.entries(this.features)
                .filter(([, supported]) => supported)
                .map(([feature]) => `micro-feature-${micro.bind.dash(feature)}`));

        this.service = null;
        if (this.features.push && this.features.serviceWorkers && this.features.es6TypedArray) {
            let url = document.querySelector("link[rel=service]").href;
            (async() => {
                this.service = await navigator.serviceWorker.register(url, {scope: "/"});
            })().catch(micro.util.catch);
        }

        let version = localStorage.microVersion || null;
        if (!version) {
            this._storeUser(null);
            localStorage.microVersion = 1;
        }

        // Go!
        let go = async() => {
            try {
                this._progressElem.style.display = "block";
                await Promise.resolve(this.update());
                this.user = JSON.parse(localStorage.microUser);

                // If requested, log in with code
                let match = /^#login=(.+)$/.exec(location.hash);
                if (match) {
                    history.replaceState(null, null, location.pathname);
                    try {
                        this._storeUser(await ui.call("POST", "/api/login", {code: match[1]}));
                    } catch (e) {
                        // Ignore invalid login codes
                        if (!(e instanceof micro.APIError)) {
                            throw e;
                        }
                    }
                }

                // If not logged in (yet), log in as a new user
                if (!this.user) {
                    this._storeUser(await ui.call("POST", "/api/login"));
                }

                this._data.settings = await ui.call("GET", "/api/settings");
                this._update();

                // Update the user details
                (async() => {
                    try {
                        let user = await ui.call("GET", `/api/users/${this.user.id}`);
                        this.dispatchEvent(new CustomEvent("user-edit", {detail: {user}}));
                    } catch (e) {
                        if (e instanceof TypeError || e instanceof micro.APIError &&
                            e.error.__type__ === "AuthenticationError") {
                            // Pass
                        } else {
                            throw e;
                        }
                    }
                })().catch(micro.util.catch);

                await this.init();

                this.querySelector(".micro-ui-header").style.display = "block";
                await this._route(location.pathname);

            } catch (e) {
                if (e instanceof TypeError) {
                    this._progressElem.style.display = "none";
                    this._open(document.createElement("micro-offline-page"));
                } else if (e instanceof micro.APIError &&
                           e.error.__type__ === "AuthenticationError") {
                    // Pass
                } else {
                    throw e;
                }
            }
        };
        go().catch(micro.util.catch);
    }

    /**
     * App settings.
     */
    get settings() {
        return this._data.settings;
    }

    /**
     * Is the current :attr:`user` a staff member?
     */
    get staff() {
        return this._data.settings.staff.map(s => s.id).indexOf(this.user.id) !== -1;
    }

    /**
     * Subclass API: Update the UI storage.
     *
     * If the storage is fresh, it will be initialized. If the storage is already up-to-date,
     * nothing will be done.
     *
     * May return a promise. Note that the UI is not available to the user before the promise
     * resolves.
     *
     * May be overridden by subclass. The default implementation does nothing. Called on startup.
     */
    update() {}

    /**
     * Subclass API: Initialize the UI.
     *
     * May return a promise. Note that the UI is not available to the user before the promise
     * resolves.
     *
     * May be overridden by subclass. The default implementation does nothing. Called on startup.
     */
    init() {}

    /**
     * Call a *method* on the HTTP JSON REST API endpoint at *url*.
     *
     * This is a wrapper around :func:`micro.call` which takes responsibility of handling
     * `AuthenticationError`s.
     */
    async call(method, url, args) {
        try {
            return await micro.call(method, url, args);
        } catch (e) {
            // Authentication errors are a corner case and happen only if a) the user has deleted
            // their account on another device or b) the database has been reset (during
            // development)
            if (e instanceof micro.APIError && e.error.__type__ === "AuthenticationError") {
                this._storeUser(null);
                location.reload();
                // Never return
                await new Promise(() => {});
            }
            throw e;
        }
    }

    /**
     * Handle a common call error *e* with a default reaction:
     *
     * - `TypeError`: Notify the user that they seem to be offline
     * - `NotFoundError`: Notify the user that the current page has been deleted
     * - `PermissionError`: Notify the user that their permissions for the current page have been
     *   revoked
     *
     * Other errors are not handled and re-thrown.
     */
    handleCallError(e) {
        if (e instanceof TypeError) {
            console.log("STRANGE ERROR", e);
            this.notify(
                "Oops, you seem to be offline! Please check your connection and try again.");
        } else if (e instanceof micro.APIError && e.error.__type__ === "NotFoundError") {
            this.notify("Oops, someone has just deleted this page!");
        } else if (e instanceof micro.APIError && e.error.__type__ === "PermissionError") {
            this.notify("Oops, someone has just revoked your permissions for this page!");
        } else {
            throw e;
        }
    }

    /**
     * Navigate to the given *url*.
     */
    async navigate(url) {
        history.pushState(null, null, url);
        await this._route(url);
    }

    /**
     * Show a *notification* to the user.
     *
     * *notification* is a :class:`HTMLElement`, like for example :class:`SimpleNotification`.
     * Alternatively, *notification* can be a simple message string to display.
     */
    notify(notification) {
        if (typeof notification === "string") {
            let elem = document.createElement("micro-simple-notification");
            let p = document.createElement("p");
            p.textContent = notification;
            elem.content.appendChild(p);
            notification = elem;
        }

        let space = this.querySelector(".micro-ui-notification-space");
        space.textContent = "";
        space.appendChild(notification);
    }

    /**
     * Show a dialog about enabling device notifications to the user.
     *
     * The result of the dialog is returned:
     *
     * - ``ok``: Notifications have been enabled
     * - ``cancel``: The user canceled the dialog
     * - ``error``: A communication error occured
     */
    async enableDeviceNotifications() {
        if (!(this.features.push && this.features.serviceWorkers && this.features.es6TypedArray)) {
            throw new Error("features");
        }

        // Chrome does not yet support base64-encoded VAPID keys (see
        // https://bugs.chromium.org/p/chromium/issues/detail?id=802280)
        let applicationServerKey = Uint8Array.from(
            atob(this.settings.push_vapid_public_key.replace(/-/g, "+").replace(/_/g, "/")),
            c => c.codePointAt(0));

        let subscription;
        try {
            subscription = await this.service.pushManager.subscribe(
                {userVisibleOnly: true, applicationServerKey});
        } catch (e) {
            if (e instanceof DOMException && e.name === "NotAllowedError") {
                return "cancel";
            }
            throw e;
        }
        subscription = JSON.stringify(subscription.toJSON());

        let user;
        try {
            user = await ui.call("PATCH", `/api/users/${this.user.id}`,
                                 {op: "enable_notifications", push_subscription: subscription});
            micro.util.dispatchEvent(this, new CustomEvent("user-edit", {detail: {user}}));
            return "ok";
        } catch (e) {
            if (e instanceof micro.APIError &&
                    e.error.__type__ === "CommunicationError") {
                ui.notify("Oops, there was a problem communicating with your device. Please try again in a few minutes.");
            } else {
                ui.handleCallError(e);
            }
            return "error";
        }
    }

    _open(page) {
        this._close();
        this.page = page;
        this._pageSpace.appendChild(page);
        this._updateTitle();
    }

    _close() {
        if (this.page) {
            this._pageSpace.removeChild(this.page);
            this.page = null;
        }
    }

    async _route(url) {
        this._close();
        this._progressElem.style.display = "block";

        let match = null;
        let route = null;
        for (route of this.pages) {
            match = new RegExp(route.url).exec(url);
            if (match) {
                break;
            }
        }

        let page;
        if (!match) {
            page = document.createElement("micro-not-found-page");
        } else if (typeof route.page === "string") {
            page = document.createElement(route.page);
        } else {
            let args = [url].concat(match.slice(1));
            try {
                page = await Promise.resolve(route.page(...args));
            } catch (e) {
                if (e instanceof TypeError) {
                    page = document.createElement("micro-offline-page");
                } else if (e instanceof micro.APIError &&
                           e.error.__type__ === "NotFoundError") {
                    page = document.createElement("micro-not-found-page");
                } else if (e instanceof micro.APIError &&
                           e.error.__type__ === "PermissionError") {
                    page = document.createElement("micro-forbidden-page");
                } else {
                    throw e;
                }
            }
        }

        this._progressElem.style.display = "none";
        this._open(page);
    }

    _updateTitle() {
        document.title = [this.page.caption, this._data.settings.title].filter(p => p).join(" - ");
    }

    _update() {
        this.classList.toggle("micro-ui-user-is-staff", this.staff);
        this.classList.toggle("micro-ui-settings-have-feedback-url",
                              this._data.settings.feedback_url);
        this.querySelector(".micro-ui-logo-text").textContent = this._data.settings.title;
        let img = this.querySelector(".micro-ui-logo img");
        if (this._data.settings.icon_small) {
            img.src = this._data.settings.icon_small;
            img.style.display = "";
        } else {
            img.style.display = "none";
        }
        this.querySelector(".micro-ui-feedback a").href = this._data.settings.feedback_url;

        this.querySelector(".micro-ui-header micro-user").user = this.user;
        this.querySelector(".micro-ui-edit-settings").style.display = this.staff ? "" : "none";
    }

    _storeUser(user) {
        this.user = user;
        if (user) {
            localStorage.microUser = JSON.stringify(user);
            document.cookie =
                `auth_secret=${user.auth_secret}; path=/; max-age=${360 * 24 * 60 * 60}`;
        } else {
            localStorage.microUser = null;
            document.cookie = "auth_secret=; path=/; max-age=0";
        }
    }

    handleEvent(event) {
        if (event.currentTarget === window && event.type === "error") {
            this.notify(document.createElement("micro-error-notification"));

        } else if (event.type === "click") {
            let a = micro.findAncestor(event.target, e => e instanceof HTMLAnchorElement, this);
            // NOTE: `a.origin === location.origin` would be more elegant, but Edge does not support
            // HTMLHyperlinkElementUtils yet (see
            // https://developer.microsoft.com/en-us/microsoft-edge/platform/documentation/apireference/interfaces/htmlanchorelement/
            // ).
            if (a && a.href.startsWith(location.origin)) {
                event.preventDefault();
                this.navigate(a.pathname).catch(micro.util.catch);
            }

        } else if (event.target === window && event.type === "popstate") {
            this._route(location.pathname).catch(micro.util.catch);

        } else if (event.target === this && event.type === "user-edit") {
            this._storeUser(event.detail.user);
            this._update();

        } else if (event.target === this && event.type === "settings-edit") {
            this._data.settings = event.detail.settings;
            this._update();
        }
    }
};

/**
 * Simple notification.
 */
micro.SimpleNotification = class extends HTMLElement {
    createdCallback() {
        this.appendChild(document.importNode(
            ui.querySelector(".micro-simple-notification-template").content, true));
        this.classList.add("micro-notification", "micro-simple-notification");
        this.querySelector(".micro-simple-notification-dismiss").addEventListener("click", this);
        this.content = this.querySelector(".micro-simple-notification-content");
    }

    handleEvent(event) {
        if (event.currentTarget === this.querySelector(".micro-simple-notification-dismiss") &&
                event.type === "click") {
            this.parentNode.removeChild(this);
        }
    }
};

/**
 * Notification that informs the user about app errors.
 */
micro.ErrorNotification = class extends HTMLElement {
    createdCallback() {
        this.appendChild(document.importNode(
            ui.querySelector(".micro-error-notification-template").content, true));
        this.classList.add("micro-notification", "micro-error-notification");
        this.querySelector(".micro-error-notification-reload").addEventListener("click", this);
    }

    handleEvent(event) {
        if (event.currentTarget === this.querySelector(".micro-error-notification-reload") &&
                event.type === "click") {
            location.reload();
        }
    }
};

/**
 * Enhanced ordered list.
 *
 * The list is sortable by the user, i.e. an user can move an item of the list by dragging it by a
 * handle. A handle is defined by the ``micro-ol-handle`` class; if an item has no handle, it cannot
 * be moved. While an item is moving, the class ``micro-ol-li-moving` is applied to it.
 *
 * Events:
 *
 * .. describe:: moveitem
 *
 *    Dispatched if an item has been moved by the user. The *detail* object of the
 *    :class:`CustomEvent` has the following attributes: *li* is the item that has been moved, from
 *    the position directly before the reference item *from* to directly before *to*. If *from* or
 *    *to* is ``null``, it means the end of the list. Thus *from* and *to* may be used in
 *    :func:`Node.insertBefore`.
 */
micro.OL = class extends HTMLOListElement {
    createdCallback() {
        this._li = null;
        this._from = null;
        this._to = null;
        this._over = null;

        this.addEventListener("mousedown", this);
        this.addEventListener("mousemove", this);
        this.addEventListener("touchstart", this);
        this.addEventListener("touchmove", this);
    }

    attachedCallback() {
        window.addEventListener("mouseup", this);
        window.addEventListener("touchend", this);
    }

    detachedCallback() {
        window.removeEventListener("mouseup", this);
        window.removeEventListener("touchend", this);
    }

    handleEvent(event) {
        if (event.currentTarget === this) {
            let handle, x, y, over;
            switch (event.type) {
            case "touchstart":
            case "mousedown":
                // Locate li intended for moving
                handle = micro.findAncestor(event.target,
                                            e => e.classList.contains("micro-ol-handle"), this);
                if (!handle) {
                    break;
                }
                this._li = micro.findAncestor(handle, e => e.parentElement === this, this);
                if (!this._li) {
                    break;
                }

                // Prevent scrolling and text selection
                event.preventDefault();
                this._from = this._li.nextElementSibling;
                this._to = null;
                this._over = this._li;
                this._li.classList.add("micro-ol-li-moving");
                ui.classList.add("micro-ui-dragging");
                break;

            case "touchmove":
            case "mousemove":
                if (!this._li) {
                    break;
                }

                // Locate li the pointer is over
                if (event.type === "touchmove") {
                    x = event.targetTouches[0].clientX;
                    y = event.targetTouches[0].clientY;
                } else {
                    x = event.clientX;
                    y = event.clientY;
                }
                over = micro.findAncestor(document.elementFromPoint(x, y),
                                          e => e.parentElement === this, this);
                if (!over) {
                    break;
                }

                // If the moving li swaps with a larger item, the pointer is still over that item
                // after the swap. We prevent accidently swapping back on the next pointer move by
                // remembering the last item the pointer was over.
                if (over === this._over) {
                    break;
                }
                this._over = over;

                if (this._li.compareDocumentPosition(this._over) &
                        Node.DOCUMENT_POSITION_PRECEDING) {
                    this._to = this._over;
                } else {
                    this._to = this._over.nextElementSibling;
                }
                this.insertBefore(this._li, this._to);
                break;

            default:
                // Unreachable
                throw new Error();
            }

        } else if (event.currentTarget === window &&
                   ["touchend", "mouseup"].indexOf(event.type) !== -1) {
            if (!this._li) {
                return;
            }

            this._li.classList.remove("micro-ol-li-moving");
            ui.classList.remove("micro-ui-dragging");
            if (this._to !== this._from) {
                event = new CustomEvent("moveitem",
                                        {detail: {li: this._li, from: this._from, to: this._to}});
                if (this.onmoveitem) {
                    this.onmoveitem(event);
                }
                this.dispatchEvent(event);
            }
            this._li = null;
        }
    }
};

/**
 * Button with an associated action that runs on click.
 *
 * While an action is running, the button is suspended, i.e. it shows a progress indicator and is
 * not clickable.
 *
 * .. attribute:: run
 *
 *    Hook function of the form *run()*, which performs the associated action. If it returns a
 *    promise, the button will be suspended until the promise resolves.
 */
micro.Button = class extends HTMLButtonElement {
    createdCallback() {
        this.run = null;
        this.addEventListener("click", event => {
            if (this.form && this.type === "submit") {
                if (this.form.checkValidity()) {
                    // Prevent default form submission
                    event.preventDefault();
                } else {
                    // Do not trigger the action and let the default validation handling kick in
                    return;
                }
            }
            this.trigger().catch(micro.util.catch);
        });
    }

    /**
     * Trigger the button.
     *
     * The associated action is run and a promise is returned which resolves to the result of
     * :attr:`run`.
     */
    async trigger() {
        if (!this.run) {
            return undefined;
        }

        let i = this.querySelector("i");
        let classes;
        this.disabled = true;
        if (i) {
            classes = i.className;
            i.className = "fa fa-spinner fa-spin";
        }
        try {
            return await Promise.resolve(this.run());
        } finally {
            this.disabled = false;
            if (i) {
                i.className = classes;
            }
        }
    }
};

/**
 * Menu containing actions and / or links.
 *
 * Menus can be nested, in which case submenus are hidden by default and expanded on focus or hover.
 *
 * The following example illustrates the markup for a typical menu::
 *
 *    <ul is="micro-menu">
 *        <li><button class="action">Do this</button></li>
 *        <li><a class="link" href="/">Something</a></li>
 *        <li>
 *            <button class="link">More</button>
 *            <ul is="micro-menu">
 *                <li><button class="action">Do that</button></li>
 *            </ul>
 *        </li>
 *    </ul>
 */
micro.Menu = class extends HTMLUListElement {
    attachedCallback() {
        let expand = event => {
            let li = Array.from(this.children).find(elem => elem.contains(event.target));
            if (["focus", "blur"].includes(event.type) && li.contains(event.relatedTarget)) {
                return;
            }
            li.classList.toggle("micro-menu-expanded",
                                ["mouseenter", "focus"].includes(event.type));
        };

        for (let li of Array.from(this.children)) {
            if (li.lastElementChild instanceof micro.Menu) {
                li.addEventListener("mouseenter", expand);
                li.addEventListener("mouseleave", expand);
                let items = Array.from(li.querySelectorAll("a, button, [tabindex]"));
                for (let item of items) {
                    item.addEventListener("focus", expand);
                    item.addEventListener("blur", expand);
                }
            }
        }
    }
};

/**
 * User element.
 *
 * .. attribute:: user
 *
 *    Represented :ref:`User`. Initialized from the JSON value of the corresponding HTML attribute,
 *    if present.
 */
micro.UserElement = class extends HTMLElement {
    createdCallback() {
        this._user = null;
        this.appendChild(document.importNode(
            document.querySelector(".micro-user-template").content, true));
        this.classList.add("micro-user");
    }

    get user() {
        return this._user;
    }

    set user(value) {
        this._user = value;
        if (this._user) {
            this.querySelector("span").textContent = this._user.name;
            this.setAttribute("title", this._user.name);
        }
    }
};

/**
 * Page.
 */
micro.Page = class extends HTMLElement {
    createdCallback() {
        this._caption = null;
    }

    /**
     * Page title. May be ``null``.
     */
    get caption() {
        return this._caption;
    }

    set caption(value) {
        this._caption = value;
        if (this === ui.page) {
            // eslint-disable-next-line no-underscore-dangle
            ui._updateTitle();
        }
    }
};

/** Offline page. */
micro.OfflinePage = class extends micro.Page {
    createdCallback() {
        super.createdCallback();
        this.caption = "Offline";
        this.appendChild(
            document.importNode(ui.querySelector("#micro-offline-page-template").content, true));
    }
};
document.registerElement("micro-offline-page", micro.OfflinePage);

/**
 * Not found page.
 */
micro.NotFoundPage = class extends micro.Page {
    createdCallback() {
        super.createdCallback();
        this.caption = "Not found";
        this.appendChild(document.importNode(
            ui.querySelector(".micro-not-found-page-template").content, true));
    }
};

/**
 * Forbidden page.
 */
micro.ForbiddenPage = class extends micro.Page {
    createdCallback() {
        super.createdCallback();
        this.caption = "Forbidden";
        this.appendChild(document.importNode(
            ui.querySelector(".micro-forbidden-page-template").content, true));
    }
};

/**
 * About page.
 */
micro.AboutPage = class extends micro.Page {
    createdCallback() {
        super.createdCallback();
        this.caption = `About ${ui.settings.title}`;
        this.appendChild(document.importNode(
            ui.querySelector(".micro-about-page-template").content, true));

        let h1 = this.querySelector("h1");
        h1.textContent = h1.dataset.text.replace("{title}", ui.settings.title);
        this.querySelector(".micro-about-short").textContent =
            this.attributes.short.value.replace("{title}", ui.settings.title);

        if (ui.settings.provider_name) {
            let text = "The service is provided by {provider}.";
            let args = {provider: ui.settings.provider_name};
            if (ui.settings.provider_url) {
                let a = document.createElement("a");
                a.classList.add("link");
                a.href = ui.settings.provider_url;
                a.target = "_blank";
                a.textContent = ui.settings.provider_name;
                args.provider = a;
            }
            if (ui.settings.provider_description.en) {
                text = "The service is provided by {provider}, {description}.";
                args.description = ui.settings.provider_description.en;
            }
            this.querySelector(".micro-about-provider").appendChild(
                micro.util.formatFragment(text, args));
        }

        this.querySelector(".micro-about-project").style.display =
            this.getAttribute("project-title") ? "" : "none";
        this.querySelector(".micro-logo a").href = this.getAttribute("project-url");
        this.querySelector(".micro-logo img").src = this.getAttribute("project-icon") || "";
        this.querySelector(".micro-logo span").textContent = this.getAttribute("project-title");
        let a = this.querySelector(".micro-about-project-link");
        a.href = this.getAttribute("project-url");
        a.textContent = this.getAttribute("project-title");
        a = this.querySelector(".micro-about-license");
        a.href = this.getAttribute("project-license-url");
        a.textContent = this.getAttribute("project-license");
        this.querySelector(".micro-about-copyright").textContent =
            this.getAttribute("project-copyright");
    }
};

/**
 * Edit user page.
 */
micro.EditUserPage = class extends micro.Page {
    static async make(url, id) {
        id = id || ui.user.id;
        let user = await ui.call("GET", `/api/users/${id}`);
        if (!(ui.user.id === user.id)) {
            return document.createElement("micro-forbidden-page");
        }
        let page = document.createElement("micro-edit-user-page");
        page.user = user;
        return page;
    }

    createdCallback() {
        super.createdCallback();
        this._user = null;
        this.caption = "Edit user settings";
        this.appendChild(document.importNode(
            ui.querySelector(".micro-edit-user-page-template").content, true));
        this._form = this.querySelector("form");
        this.querySelector(".micro-edit-user-edit").addEventListener("submit", this);

        this._setEmail1 = this.querySelector(".micro-edit-user-set-email-1");
        this._setEmailForm = this.querySelector(".micro-edit-user-set-email-1 form");
        this._setEmail2 = this.querySelector(".micro-edit-user-set-email-2");
        this._emailP = this.querySelector(".micro-edit-user-email-value");
        this._setEmailAction = this.querySelector(".micro-edit-user-set-email-1 form button");
        this._cancelSetEmailAction = this.querySelector(".micro-edit-user-cancel-set-email button");
        this._removeEmailAction = this.querySelector(".micro-edit-user-remove-email button");
        this._removeEmailAction.addEventListener("click", this);
        this._setEmailAction.addEventListener("click", this);
        this._cancelSetEmailAction.addEventListener("click", this);
        this._setEmailForm.addEventListener("submit", e => e.preventDefault());
    }

    attachedCallback() {
        (async() => {
            let match = /^#set-email=([^:]+):([^:]+)$/.exec(location.hash);
            if (match) {
                history.replaceState(null, null, location.pathname);
                let authRequestID = `AuthRequest:${match[1]}`;
                let authRequest = JSON.parse(localStorage.authRequest || null);
                if (!authRequest || authRequestID !== authRequest.id) {
                    ui.notify(
                        "The email link was not opened on the same browser/device on which the email address was entered (or the email link is outdated).");
                    return;
                }

                this._showSetEmailPanel2(true);
                try {
                    this.user = await ui.call(
                        "POST", `/api/users/${this._user.id}/finish-set-email`, {
                            auth_request_id: authRequest.id,
                            auth: match[2]
                        });
                    delete localStorage.authRequest;
                    this._hideSetEmailPanel2();
                } catch (e) {
                    if (e instanceof micro.APIError && e.__type__ === "ValueError") {
                        if (e.error.code === "auth_invalid") {
                            this._showSetEmailPanel2();
                            ui.notify("The email link was modified. Please try again.");
                        } else {
                            delete localStorage.authRequest;
                            this._hideSetEmailPanel2();
                            ui.notify({
                                auth_request_not_found:
                                    "The email link is expired. Please try again.",
                                email_duplicate:
                                    "The given email address is already in use by another user."
                            }[e.error.code]);
                        }
                    } else {
                        ui.handleCallError(e);
                    }
                }
            }
        })().catch(micro.util.catch);
    }

    /**
     * :ref:`User` to edit.
     */
    get user() {
        return this._user;
    }

    set user(value) {
        this._user = value;
        this.classList.toggle("micro-edit-user-has-email", this._user.email);
        this._form.elements.name.value = this._user.name;
        this._emailP.textContent = this._user.email;
    }

    async _setEmail() {
        if (!this._setEmailForm.checkValidity()) {
            return;
        }

        try {
            let authRequest = await ui.call("POST", `/api/users/${this.user.id}/set-email`, {
                email: this._setEmailForm.elements.email.value
            });
            localStorage.authRequest = JSON.stringify(authRequest);
            this._setEmailForm.reset();
            this._showSetEmailPanel2();
        } catch (e) {
            ui.handleCallError(e);
        }
    }

    _cancelSetEmail() {
        this._hideSetEmailPanel2();
    }

    async _removeEmail() {
        try {
            this.user = await ui.call("POST", `/api/users/${this.user.id}/remove-email`);
        } catch (e) {
            if (e instanceof micro.APIError && e.__type__ === "ValueError") {
                // If the email address has already been removed, we just update the UI
                this.user.email = null;
                this.user = this.user;
            } else {
                ui.handleCallError(e);
            }
        }
    }

    _showSetEmailPanel2(progress) {
        progress = progress || false;
        let progressP = this.querySelector(".micro-edit-user-set-email-2 .micro-progress");
        let actions = this.querySelector(".micro-edit-user-cancel-set-email");
        this._emailP.style.display = "none";
        this._setEmail1.style.display = "none";
        this._setEmail2.style.display = "block";
        if (progress) {
            progressP.style.display = "";
            actions.style.display = "none";
        } else {
            progressP.style.display = "none";
            actions.style.display = "";
        }
    }

    _hideSetEmailPanel2() {
        this._emailP.style.display = "";
        this._setEmail1.style.display = "";
        this._setEmail2.style.display = "";
    }

    handleEvent(event) {
        if (event.currentTarget === this._form) {
            event.preventDefault();
            (async() => {
                try {
                    let user = await ui.call("POST", `/api/users/${this._user.id}`, {
                        name: this._form.elements.name.value
                    });
                    ui.dispatchEvent(new CustomEvent("user-edit", {detail: {user}}));
                } catch (e) {
                    if (e instanceof micro.APIError && e.error.__type__ === "InputError") {
                        ui.notify("The name is missing.");
                    } else {
                        ui.handleCallError(e);
                    }
                }
            })().catch(micro.util.catch);

        } else if (event.currentTarget === this._setEmailAction && event.type === "click") {
            this._setEmail().catch(micro.util.catch);
        } else if (event.currentTarget === this._cancelSetEmailAction && event.type === "click") {
            this._cancelSetEmail();
        } else if (event.currentTarget === this._removeEmailAction && event.type === "click") {
            this._removeEmail().catch(micro.util.catch);
        }
    }
};

/**
 * Edit settings page.
 */
micro.EditSettingsPage = class extends micro.Page {
    static make() {
        if (!ui.staff) {
            return document.createElement("micro-forbidden-page");
        }
        return document.createElement("micro-edit-settings-page");
    }

    createdCallback() {
        super.createdCallback();
        this.caption = "Edit site settings";
        this.appendChild(
            document.importNode(ui.querySelector(".micro-edit-settings-page-template").content,
                                true));
        this._data = {
            settings: ui.settings,

            edit: async() => {
                function toStringOrNull(str) {
                    return str.trim() ? str : null;
                }

                let form = this.querySelector("form");
                let description = toStringOrNull(form.elements.provider_description.value);
                description = description ? {en: description} : {};

                try {
                    let settings = await ui.call("POST", "/api/settings", {
                        title: form.elements.title.value,
                        icon: form.elements.icon.value,
                        icon_small: form.elements.icon_small.value,
                        icon_large: form.elements.icon_large.value,
                        provider_name: form.elements.provider_name.value,
                        provider_url: form.elements.provider_url.value,
                        provider_description: description,
                        feedback_url: form.elements.feedback_url.value
                    });
                    ui.navigate("/").catch(micro.util.catch);
                    micro.util.dispatchEvent(ui,
                                             new CustomEvent("settings-edit", {detail: {settings}}));
                } catch (e) {
                    ui.handleCallError(e);
                }
            }
        };
        micro.bind.bind(this.children, this._data);
    }
};

micro.ActivityPage = class extends micro.Page {
    static make() {
        if (!ui.staff) {
            return document.createElement("micro-forbidden-page");
        }
        return document.createElement("micro-activity-page");
    }

    createdCallback() {
        super.createdCallback();
        this.caption = "Site activity";
        this.appendChild(document.importNode(
            ui.querySelector(".micro-activity-page-template").content, true));
        this._data = {
            events: new micro.bind.Watchable([]),

            formatDate(ctx, time) {
                return new Date(time).toLocaleString("en", micro.SHORT_DATE_TIME_FORMAT);
            },

            renderEvent(ctx, event) {
                return ui.renderEvent[event.type](event);
            },

            showMore: this._showMore.bind(this)
        };
        micro.bind.bind(this.children, this._data);

        this._start = 0;
    }

    attachedCallback() {
        this.querySelector("button").trigger().catch(micro.util.catch);
        this.stream = new EventSource("/api/activity/v2/stream");
        // TODO unsubscribe
        this.stream.addEventListener("open", event => {
            console.log("open", event);
        });
        this.stream.addEventListener("error", event => {
            console.log("error", event);
        });
        this.stream.addEventListener("message", event => {
            console.log("message", event);
            let e = JSON.parse(event.data);
            ui.dispatchEvent(new CustomEvent(e.type, {detail: e}));

            this._data.events.unshift(e);
            animate(this.querySelector(".micro-timeline li:first-child"));
        });
    }

    async _showMore() {
        let events;
        try {
            events = await ui.call("GET", `/api/activity/${this._start}:`);
        } catch (e) {
            ui.handleCallError(e);
            return;
        }
        this._data.events.splice(this._start, 0, ...events);
        this.classList.toggle("micro-activity-all", events.length < micro.LIST_LIMIT);
        this._start += micro.LIST_LIMIT;

        animate(this.querySelector(".micro-timeline li:first-child"));
    }
};

function animate(elem) {
    elem.classList.add("micro-modified");
    elem.addEventListener("animationend", () => elem.classList.remove("micro-modified"));
}

document.registerElement("micro-ui", {prototype: micro.UI.protoype, extends: "body"});
document.registerElement("micro-simple-notification", micro.SimpleNotification);
document.registerElement("micro-error-notification", micro.ErrorNotification);
document.registerElement("micro-ol", {prototype: micro.OL.prototype, extends: "ol"});
document.registerElement("micro-button", {prototype: micro.Button.prototype, extends: "button"});
document.registerElement("micro-menu", {prototype: micro.Menu.prototype, extends: "ul"});
document.registerElement("micro-user", micro.UserElement);
document.registerElement("micro-page", micro.Page);
document.registerElement("micro-not-found-page", micro.NotFoundPage);
document.registerElement("micro-forbidden-page", micro.ForbiddenPage);
document.registerElement("micro-about-page", micro.AboutPage);
document.registerElement("micro-edit-user-page", micro.EditUserPage);
document.registerElement("micro-edit-settings-page", micro.EditSettingsPage);
document.registerElement("micro-activity-page", micro.ActivityPage);
