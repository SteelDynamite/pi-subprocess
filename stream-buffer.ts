export interface CappedTextAppendResult {
	text: string;
	truncated: boolean;
	bytes: number;
}

export function appendCappedText(current: string, chunk: string, maxBytes: number): CappedTextAppendResult {
	const next = current + chunk;
	const bytes = Buffer.byteLength(next, "utf8");
	if (bytes <= maxBytes) return { text: next, truncated: false, bytes };

	let truncated = next.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return { text: truncated, truncated: true, bytes };
}
