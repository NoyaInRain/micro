/*
 * bind.js
 * Released into the public domain
 * https://github.com/noyainrain/micro/blob/master/client/bind.js
 */

/* eslint-env mocha */
/* global chai */
/* eslint-disable prefer-arrow-callback */

"use strict";

let {expect} = chai;

describe("Watchable", function() {
    describe("on set", function() {
        it("should notify watchers", function() {
            let object = new micro.bind.Watchable();
            let calls = [];
            object.watch("foo", (...args) => calls.push(args));
            object.foo = 42;
            expect(object.foo).to.equal(42);
            expect(calls).to.deep.equal([["foo", 42]]);
        });
    });

    describe("splice()", function() {
        it("should notify watchers", function() {
            let arr = new micro.bind.Watchable(["a", "b", "c", "d"]);
            let calls = [];
            arr.watch(Symbol.for("+"), (...args) => calls.push(["+"].concat(args)));
            arr.watch(Symbol.for("-"), (...args) => calls.push(["-"].concat(args)));
            arr.splice(1, 2, "x", "y");
            expect(arr).to.deep.equal(["a", "x", "y", "d"]);
            expect(calls).to.deep.equal([["-", "2", "c"], ["-", "1", "b"], ["+", "1", "x"],
                                         ["+", "2", "y"]]);
        });
    });

    describe("push()", function() {
        it("should notify watchers", function() {
            let arr = new micro.bind.Watchable(["a", "b"]);
            let calls = [];
            arr.watch(Symbol.for("+"), (...args) => calls.push(args));
            arr.push("c");
            expect(arr).to.deep.equal(["a", "b", "c"]);
            expect(calls).to.deep.equal([["2", "c"]]);
        });
    });
});

describe("filter()", function() {
    function makeArrays() {
        let arr = new micro.bind.Watchable(["a1", "b1", "a2", "b2"]);
        return [arr, micro.bind.filter(arr, item => item.startsWith("a"))];
    }

    describe("on arr set", function() {
        it("should update item if item still passes", function() {
            let [arr, filtered] = makeArrays();
            arr[2] = "ax";
            expect(filtered).to.deep.equal(["a1", "ax"]);
        });

        it("should include item if item passes now", function() {
            let [arr, filtered] = makeArrays();
            arr[1] = "ax";
            expect(filtered).to.deep.equal(["a1", "ax", "a2"]);
        });

        it("should exclude item if item does not pass anymore", function() {
            let [arr, filtered] = makeArrays();
            arr[0] = "bx";
            expect(filtered).to.deep.equal(["a2"]);
        });

        it("should have no effect if item still does not pass", function() {
            let [arr, filtered] = makeArrays();
            arr[1] = "bx";
            expect(filtered).to.deep.equal(["a1", "a2"]);
        });
    });

    describe("on arr splice", function() {
        it("should update filtered array", function() {
            let [arr, filtered] = makeArrays();
            arr.splice(1, 2, "ax", "bx");
            expect(filtered).to.deep.equal(["a1", "ax"]);
        });
    });
});

describe("bind()", function() {
    function setupDOMWithList() {
        document.body.innerHTML = `
            <ul data-content="list items 'item'">
                <template><li data-content="item"></li></template>
            </ul>
        `;
        let ul = document.body.firstElementChild;
        let arr = new micro.bind.Watchable(["a", "b", "c"]);
        micro.bind.bind(ul, {items: arr});
        return [arr, ul];
    }

    it("should update DOM", function() {
        document.body.innerHTML = '<span data-title="value"></span>';
        let span = document.body.firstElementChild;
        micro.bind.bind(span, {value: "Purr"});
        expect(span.title).to.equal("Purr");
    });

    it("should update DOM with transform", function() {
        document.body.innerHTML = '<span data-title="not value"></span>';
        let span = document.body.firstElementChild;
        micro.bind.bind(span, {value: true});
        expect(span.title).to.equal("false");
    });

    it("should update DOM with content", function() {
        document.body.innerHTML = '<span data-content="value"></span>';
        let span = document.body.firstElementChild;
        micro.bind.bind(span, {value: "Purr"});
        expect(span.textContent).to.equal("Purr");
    });

    it("should update DOM with class", function() {
        document.body.innerHTML = '<span data-class-cat="value"></span>';
        let span = document.body.firstElementChild;
        micro.bind.bind(span, {value: true});
        expect(span.className).to.equal("cat");
    });

    it("should update DOM with join", function() {
        document.body.innerHTML = `
            <p data-content="join items 'item'">
                <template><span data-content="item"></span></template>
            </p>
        `;
        let p = document.body.firstElementChild;
        micro.bind.bind(p, {items: ["a", "b", "c"]});
        let nodes = Array.from(p.childNodes, n => n.textContent);
        expect(nodes).to.deep.equal(["a", ", ", "b", ", ", "c"]);
    });

    it("should update DOM with nested binding", function() {
        document.body.innerHTML = '<p data-title="outer"><span data-title="inner"></span></p>';
        let p = document.body.firstElementChild;
        let span = document.querySelector("span");
        micro.bind.bind(span, {inner: "Inner"});
        micro.bind.bind(p, {outer: "Outer"});
        expect(span.title).to.equal("Inner");
        expect(p.title).to.equal("Outer");
    });

    it("should fail if reference is undefined", function() {
        document.body.innerHTML = '<span data-title="value"></span>';
        let span = document.body.firstElementChild;
        expect(() => micro.bind.bind(span, {})).to.throw(ReferenceError);
    });

    it("should fail if transform is not a function", function() {
        document.body.innerHTML = '<span data-title="value 42"></span>';
        let span = document.body.firstElementChild;
        let data = {value: true};
        expect(() => micro.bind.bind(span, data)).to.throw(TypeError);
    });

    describe("on data set", function() {
        it("should update DOM", function() {
            document.body.innerHTML = '<span data-title="value"></span>';
            let span = document.body.firstElementChild;
            let data = new micro.bind.Watchable({value: null});
            micro.bind.bind(span, data);
            data.value = "Purr";
            expect(span.title).to.equal("Purr");
        });
    });

    describe("on data arr set", function() {
        it("should update DOM with list", function() {
            let [arr, ul] = setupDOMWithList();
            arr[1] = "x";
            expect(Array.from(ul.children, c => c.textContent)).to.deep.equal(["a", "x", "c"]);
        });
    });

    describe("on data arr splice", function() {
        it("should update DOM with list", function() {
            let [arr, ul] = setupDOMWithList();
            arr.splice(1, 1, "x", "y");
            expect(Array.from(ul.children, c => c.textContent)).to.deep.equal(["a", "x", "y", "c"]);
        });
    });
});

describe("parse()", function() {
    it("should parse expression", function() {
        let args = micro.bind.parse("true false null undefined 'word word' 42 x.y");
        expect(args).to.deep.equal([true, false, null, undefined, "word word", 42,
                                    {name: "x.y", tokens: ["x", "y"]}]);
    });
});
