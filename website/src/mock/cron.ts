/**
 * Next fire time for the five-field cron strings the fixtures and forms use.
 * ponytail: minute-step search over 8 days, handles numbers, lists, ranges,
 * steps and `*`; swap for a cron library if the demo ever needs L/W/# syntax.
 */
function matches(field: string, value: number): boolean {
	return field.split(",").some((part) => {
		const [range, stepText] = part.split("/");
		const step = stepText ? Number(stepText) : 1;
		if (!Number.isInteger(step) || step < 1) return false;
		let low: number;
		let high: number;
		if (range === "*") {
			low = 0;
			high = 59;
		} else if (range?.includes("-")) {
			[low, high] = range.split("-").map(Number) as [number, number];
		} else {
			low = Number(range);
			high = stepText ? 59 : low;
		}
		if (!Number.isFinite(low) || !Number.isFinite(high)) return false;
		return value >= low && value <= high && (value - low) % step === 0;
	});
}

export function isCron(expression: string): boolean {
	const fields = expression.trim().split(/\s+/);
	return fields.length === 5 && fields.every((field) => /^[\d*,/-]+$/.test(field));
}

export function nextFire(expression: string, from: number): number | null {
	if (!isCron(expression)) return null;
	const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/) as [string, string, string, string, string];
	const start = new Date(from);
	start.setUTCSeconds(0, 0);
	let t = start.getTime() + 60_000;
	for (let i = 0; i < 8 * 24 * 60; i++, t += 60_000) {
		const d = new Date(t);
		if (
			matches(minute, d.getUTCMinutes()) &&
			matches(hour, d.getUTCHours()) &&
			matches(day, d.getUTCDate()) &&
			matches(month, d.getUTCMonth() + 1) &&
			matches(weekday, d.getUTCDay())
		)
			return t;
	}
	return null;
}
