import { afterAll, expect, test } from "bun:test";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, SettingsManager, type TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { Editor, setCapabilities, setCellDimensions, type Component } from "@earendil-works/pi-tui";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imageStoreExtension, { ContentAddressedImageStore, DETAILS_KEY, renderStoredImagePreviews } from "./index";
import { encodePng } from "./png";

const KITTY = "\x1b_G";
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];

afterAll(async () => {
	if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function until(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out: ${label}`);
}

test("pasted image paths show as [Image N] tokens with thumbnails and a viewer, and attach their images", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-image-store-paste-"));
	roots.push(root);
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	setCellDimensions({ widthPx: 10, heightPx: 20 });

	const identity = (text: string) => text;
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: identity, inverse: (text: string) => `\x1b[7m${text}\x1b[27m` };
	let invalidations = 0;
	const tui = { requestRender: () => {}, invalidate: () => { invalidations++; }, getFocusedComponent: () => focused, terminal: { rows: 40, columns: 100 } };
	const focused = new Editor(tui as never, { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } });
	const shot = join(root, "client-78-clipboard-1.png");
	await writeFile(shot, encodePng({ width: 320, height: 180, data: new Uint8Array(320 * 180 * 4).map((_, index) => index % 4 === 3 ? 255 : (index * 7) & 0xff) }));

	let editor = "";
	let paste: TerminalInputHandler | undefined;
	let widget: Component | undefined;
	let viewer: (Component & { handleInput(data: string): void }) | undefined;
	const notices: string[] = [];
	const services = await createAgentSessionServices({
		cwd: root,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		settingsManager: SettingsManager.inMemory({}),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [(pi) => imageStoreExtension(pi)] },
	});
	const manager = SessionManager.inMemory(root);
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, noTools: "all" });
	try {
		await session.bindExtensions({
			mode: "tui",
			uiContext: {
				...session.extensionRunner.getUIContext(),
				theme: theme as never,
				notify: (message) => notices.push(message),
				getEditorText: () => editor,
				setEditorText: (text) => { editor = text; },
				onTerminalInput: (handler) => {
					paste = handler;
					return () => { paste = undefined; };
				},
				setWidget: ((key: string, factory: unknown) => {
					if (key === "image-store-paste" && typeof factory === "function") widget = factory(tui, theme);
				}) as never,
				custom: (async (factory: (...args: unknown[]) => Component & { handleInput(data: string): void }) => {
					await new Promise<void>((resolve) => { viewer = factory(tui, theme, undefined, () => resolve()); });
					viewer = undefined;
				}) as never,
			},
		});
		if (!paste || !widget) throw new Error("TUI sessions install the paste listener and draft widget");
		const draftThumbnail = () => widget!.render(100).some((line) => line.includes(KITTY));

		// Terminals and Herdr paste clipboard images as file paths.
		expect(paste("\x1b[200~hello\x1b[201~")).toBeUndefined();
		const pasted = paste(`\x1b[200~${shot}\x1b[201~`);
		expect(pasted).toEqual({ data: "\x1b[200~[Image 1] \x1b[201~" });
		// One Backspace removes a whole live token.
		for (const key of [pasted!.data!, "\x7f", "\x7f"]) focused.handleInput(key);
		expect(focused.getText()).toBe("");
		editor = "look [Image 1]";
		await until(draftThumbnail, "draft thumbnail");

		// Pi's own Ctrl+V inserts a temporary path; it becomes the next token.
		const piClipboard = join(root, "pi-clipboard-0b4c6a3e-2f7d-4c5e-9a1b-3c2d1e0f9a8b.png");
		await writeFile(piClipboard, encodePng({ width: 20, height: 20, data: new Uint8Array(1600).fill(200) }));
		editor = `look [Image 1] and ${piClipboard}`;
		widget.render(100);
		await until(() => editor === "look [Image 1] and [Image 2]", "Pi clipboard path normalized");

		// Clicking a thumbnail opens the viewer at that image; ←/→ step through the prompt's images.
		// The first thumbnail starts after a one-column margin.
		expect(widget.handleMouse!({ type: "click", button: "left", x: 1, y: 0 } as never)).toEqual({ handled: true });
		await until(() => viewer !== undefined, "viewer opened");
		await until(() => viewer!.render(100).some((line) => line.includes(KITTY)), "viewer image");
		expect(viewer!.render(100)[0]).toMatch(/Image 1 of 2/);
		viewer!.handleInput("\x1b[C");
		expect(viewer!.render(100)[0]).toMatch(/Image 2 of 2/);
		viewer!.handleInput("\x1b");
		await until(() => viewer === undefined, "viewer closed");
		const viewing = session.prompt("/image-store view");
		await until(() => viewer !== undefined, "viewer opened by command");
		expect(viewer!.render(100)[0]).toMatch(/Image 2 of 2/);
		viewer!.handleInput("\x1b");
		await viewing;

		// Submitting clears the editor, and Pi can render before the input event runs.
		const submitted = editor;
		editor = "";
		widget.render(100);
		const input = await session.extensionRunner.emitInput(submitted, undefined, "interactive");
		// Tokens stay in the text; image-store takes the attachments as for any pasted image.
		expect(input).toEqual({ action: "transform", text: submitted, images: [] });
		const original = (await readFile(shot)).toString("base64");
		const entries = manager.getEntries() as any[];
		expect(entries.filter((entry) => entry.customType === "image-store-v1").map((entry) => entry.data.label)).toEqual(["pasted image", "pasted image"]);
		const sidecar = entries.find((entry) => entry.type === "custom_message");
		expect(JSON.stringify(entries)).not.toContain(original);
		const context = await session.extensionRunner.emitContext([{ role: "custom", customType: sidecar.customType, content: sidecar.content, display: false, details: sidecar.details, timestamp: Date.now() } as never]);
		const blocks = (context[0] as any).content;
		expect(blocks.map((block: any) => block.type)).toEqual(["text", "image", "image"]);
		expect(blocks[1].data).toBe(original);
		expect((await session.extensionRunner.emitInput("again [Image 1]", undefined, "interactive")).action).toBe("continue");
		expect(notices).toEqual([]);

		// Previews can be turned off; tokens stay highlighted.
		editor = "look [Image 1]";
		expect(paste(`\x1b[200~${shot}\x1b[201~`)).toEqual({ data: "\x1b[200~[Image 1] \x1b[201~" });
		await until(draftThumbnail, "draft thumbnail before toggling");
		await session.prompt("/image-store preview off");
		expect(widget.render(100)).toEqual([]);
		focused.handleInput("\x1b[200~[Image 1] \x1b[201~");
		expect(focused.render(100).join("\n")).toMatch(/\x1b\[7m[^\n]*?\[Image 1\]/);
		focused.setText("");
		await session.prompt("/image-store rows 4");
		await session.prompt("/image-store color #FE8019");
		await session.prompt("/image-store rows 99");
		expect(invalidations).toBe(3);
		expect(JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "image-store.json"), "utf8"))).toEqual({ preview: false, previewRows: 4, tokenColor: "#fe8019" });
		expect(notices.at(-2)).toMatch(/Image previews off · rows 4 · token color #fe8019/);
		expect(notices.at(-1)).toMatch(/^Usage: \/image-store/);

		// Clearing the editor abandons its draft; the next paste numbers from 1 again.
		editor = "";
		expect(paste(`\x1b[200~${shot}\x1b[201~`)).toEqual({ data: "\x1b[200~[Image 1] \x1b[201~" });

		// Clicking a stored image in the transcript opens the viewer at it, across the branch's images.
		const store = new ContentAddressedImageStore(process.env.PI_CODING_AGENT_DIR);
		const png = (fill: number) => ({ type: "image" as const, data: encodePng({ width: 40, height: 30, data: new Uint8Array(40 * 30 * 4).fill(fill) }).toString("base64"), mimeType: "image/png" });
		const first = await store.put(png(90));
		const second = await store.put(png(200));
		const details = { [DETAILS_KEY]: { version: 1, refs: [first, second] } };
		manager.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "[image stored externally]" }], details, isError: false, timestamp: Date.now() } as never);
		const readRow = renderStoredImagePreviews(details, store, theme, true)!;
		const heights = [first, second].map((ref) => renderStoredImagePreviews({ [DETAILS_KEY]: { version: 1, refs: [ref] } }, store, theme, true)!.render(100).length);
		readRow.render(100);
		expect(readRow.handleMouse!({ type: "click", button: "left", x: 2, y: heights[0]!, height: heights[0]! + heights[1]! } as never)).toEqual({ handled: true });
		await until(() => viewer !== undefined, "viewer opened from a read row");
		// The two pasted images come first, then the read row's two.
		expect(viewer!.render(100)[0]).toMatch(/Image 4 of 4/);
		expect(viewer!.render(100).at(-1)).toContain(`image ${second.digest.slice(0, 8)}`);
		viewer!.handleInput("\x1b[D");
		expect(viewer!.render(100)[0]).toMatch(/Image 3 of 4/);
		viewer!.handleInput("\x1b");
		await until(() => viewer === undefined, "viewer closed");
	} finally {
		session.dispose();
	}
}, 30_000);
