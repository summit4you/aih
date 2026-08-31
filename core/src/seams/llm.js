export class MockLLM {
    #script;
    #cursor = 0;
    constructor(script) {
        this.#script = script.map((partial) => ({
            text: partial.text ?? "",
            toolCalls: partial.toolCalls ?? [],
            stopReason: partial.stopReason ??
                (partial.toolCalls && partial.toolCalls.length > 0
                    ? "tool_use"
                    : "end_turn"),
            ...(partial.finishReason !== undefined ? { finishReason: partial.finishReason } : {}),
            ...(partial.usage ? { usage: partial.usage } : {}),
        }));
    }
    async complete(req) {
        const next = this.#script[this.#cursor] ?? {
            text: "",
            toolCalls: [],
            stopReason: "end_turn",
        };
        this.#cursor += 1;
        if (req.onDelta && next.text) {
            for (const piece of next.text.match(/.{1,12}/gs) ?? []) {
                req.onDelta(piece);
            }
        }
        return next;
    }
}
export function toolCall(id, name, args) {
    return { id, name, args };
}
