/**
 * The agent settings dialog sends only changed fields, and never drops or
 * changes an account spending ceiling it does not manage.
 */
import { describe, expect, test } from "bun:test";
import { buildPatch, forEditing } from "../web/src/console/definition/model";

const loaded = {
	name: "reviewer",
	description: "Reviews changes.",
	body: "Be careful.",
	spawns: "*",
	rooms: ["#reviews"],
	autonomy: { maxTurns: 10, budgetUsd: 5 },
	sandbox: { enabled: true, extraRoots: ["/tmp"] },
};

describe("definition patch", () => {
	test("an unchanged editing copy patches nothing, whatever the key order", () => {
		const editing = forEditing(loaded);
		expect(editing.autonomy).toEqual({ maxTurns: 10 });
		expect("name" in editing).toBe(false);
		const reordered = {
			...editing,
			sandbox: { extraRoots: ["/tmp"], enabled: true },
		};
		expect(buildPatch(loaded, reordered)).toEqual({});
	});

	test("only changed fields are sent, and an omitted field is not a removal", () => {
		expect(buildPatch(loaded, { description: "Edited." })).toEqual({
			description: "Edited.",
		});
		expect(buildPatch(loaded, { ...forEditing(loaded), rooms: [] })).toEqual({
			rooms: [],
		});
	});

	test("a changed autonomy carries the loaded ceiling forward", () => {
		const editing = forEditing(loaded);
		expect(
			buildPatch(loaded, { ...editing, autonomy: { maxTurns: 20 } }),
		).toEqual({
			autonomy: { maxTurns: 20, budgetUsd: 5 },
		});
		// No ceiling loaded: none is invented.
		const { autonomy: _a, ...bare } = loaded;
		expect(buildPatch(bare, { autonomy: { maxTurns: 3 } })).toEqual({
			autonomy: { maxTurns: 3 },
		});
	});

	test("a changed ceiling is refused", () => {
		expect(() =>
			buildPatch(loaded, { autonomy: { maxTurns: 10, budgetUsd: 50 } }),
		).toThrow("managed outside the console");
		// Restating the loaded ceiling is not a change.
		expect(
			buildPatch(loaded, { autonomy: { maxTurns: 10, budgetUsd: 5 } }),
		).toEqual({});
	});
});
