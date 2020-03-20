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
 * Hello UI.
 */

"use strict";

window.hello = {};

/**
 * Hello UI.
 */
hello.UI = class extends micro.UI {
    init() {
        function makeAboutPage() {
            return document.importNode(ui.querySelector(".hello-about-page-template").content, true)
                .querySelector("micro-about-page");
        }

        this.pages = this.pages.concat([
            // {url: "^/$", page: "hello-start-page"},
            {url: "^/$", page: () => new hello.StartPage()},
            {url: "^/about$", page: makeAboutPage}
        ]);
    }
};
customElements.define("hello-ui", hello.UI);

/**
 * Start page.
 */
hello.StartPage = class extends micro.Page {
    constructor() {
        super();
        this._activity = null;

        this.appendChild(
            document.importNode(ui.querySelector(".hello-start-page-template").content, true));
        this._data = new micro.bind.Watchable({
            settings: ui.settings,
            greetings: new micro.Collection("/api/greetings"),

            createGreeting: async() => {
                try {
                    const form = this.querySelector("form");
                    const text = form.elements.text.value;
                    const match = text.match(/^https?:\/\/\S+/u);
                    const resource = match ? match[0] : null;
                    await ui.call("POST", "/api/greetings", {text, resource});
                    form.reset();
                } catch (e) {
                    if (
                        e instanceof micro.APIError &&
                        [
                            "CommunicationError", "NoResourceError", "ForbiddenResourceError",
                            "BrokenResourceError"
                        ].includes(e.error.__type__)
                    ) {
                        ui.notify("Oops, there was a problem opening the link. Please try again in a few moments.");
                    } else {
                        ui.handleCallError(e);
                    }
                }
            },

            makeGreetingHash(ctx, greeting) {
                return `greetings-${greeting.id.split(":")[1]}`;
            }
        });
        micro.bind.bind(this.children, this._data);
    }

    connectedCallback() {
        super.connectedCallback();
        this.ready.when((async() => {
            try {
                await this._data.greetings.fetch();
                this._activity = await micro.Activity.open("/api/activity/stream");
                this._activity.events.addEventListener(
                    "greetings-create",
                    event => this._data.greetings.items.unshift(event.detail.event.detail.greeting)
                );
            } catch (e) {
                ui.handleCallError(e);
            }
        })().catch(micro.util.catch));
    }

    disconnectedCallback() {
        if (this._activity) {
            this._activity.close();
        }
    }
};
customElements.define("hello-start-page", hello.StartPage);
