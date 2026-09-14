/**
 * Resizable console panels: width clamps and storage fallbacks.
 *
 * @Environment bun
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	canDockThread,
	clampSidebar,
	clampThread,
	readStoredWidth,
	storeWidth,
} from "../web/src/lib/panel-size";

const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(storage: unknown) {
	Object.defineProperty(globalThis, "localStorage", {
		value: storage,
		configurable: true,
		writable: true,
	});
}

afterEach(() => {
	if (realStorage)
		Object.defineProperty(globalThis, "localStorage", realStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("clampSidebar", () => {
	test("holds 220–420px on wide viewports", () => {
		expect(clampSidebar(100, 2560)).toBe(220);
		expect(clampSidebar(220, 2560)).toBe(220);
		expect(clampSidebar(300, 2560)).toBe(300);
		expect(clampSidebar(420, 2560)).toBe(420);
		expect(clampSidebar(900, 2560)).toBe(420);
	});

	test("never exceeds 40% of the viewport", () => {
		expect(clampSidebar(420, 800)).toBe(320);
		expect(clampSidebar(420, 768)).toBe(307);
		expect(clampSidebar(300, 768)).toBe(300);
	});

	test("keeps the minimum when 40% is smaller than it", () => {
		expect(clampSidebar(400, 500)).toBe(220);
	});
});

describe("clampThread", () => {
	test("holds 320–720px when space is plentiful", () => {
		expect(clampThread(100, 2400)).toBe(320);
		expect(clampThread(320, 2400)).toBe(320);
		expect(clampThread(500, 2400)).toBe(500);
		expect(clampThread(720, 2400)).toBe(720);
		expect(clampThread(2000, 2400)).toBe(720);
	});

	test("never exceeds 50% of the available space", () => {
		expect(clampThread(720, 1200)).toBe(600);
		expect(clampThread(720, 1000)).toBe(500);
	});

	test("leaves the channel column its 480px", () => {
		expect(clampThread(720, 900)).toBe(420);
		expect(clampThread(400, 800)).toBe(320);
	});

	test("docks only when thread and channel both fit", () => {
		expect(canDockThread(799)).toBe(false);
		expect(canDockThread(800)).toBe(true);
	});
});

describe("stored widths", () => {
	test("round-trips a width", () => {
		const data = new Map<string, string>();
		installStorage({
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => data.set(k, v),
		});
		storeWidth("oma-sidebar-width", 301.6);
		expect(data.get("oma-sidebar-width")).toBe("302");
		expect(readStoredWidth("oma-sidebar-width", 260)).toBe(302);
	});

	test("falls back on missing, garbage, or non-positive values", () => {
		const data = new Map<string, string>([
			["bad", "wide"],
			["zero", "0"],
		]);
		installStorage({
			getItem: (k: string) => data.get(k) ?? null,
			setItem: () => {},
		});
		expect(readStoredWidth("missing", 260)).toBe(260);
		expect(readStoredWidth("bad", 260)).toBe(260);
		expect(readStoredWidth("zero", 400)).toBe(400);
	});

	test("survives storage that throws", () => {
		installStorage({
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		});
		expect(readStoredWidth("oma-thread-width", 400)).toBe(400);
		expect(() => storeWidth("oma-thread-width", 500)).not.toThrow();
	});
});
