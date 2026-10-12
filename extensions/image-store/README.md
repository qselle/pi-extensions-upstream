# image-store

Keeps image-heavy sessions responsive by storing image bytes as content-addressed
sidecar files instead of embedding base64 payloads in session JSONL.

Images are written under Pi's agent directory:

```text
$PI_CODING_AGENT_DIR/image-store/sha256/<prefix>/<sha256>.<ext>
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`.

The session stores only a small structured SHA-256 reference. Before each model
request, references in the active context are rehydrated in memory, so the model
still receives the original image.

## Terminal behavior

- Tool images render immediately in their native `read` rows for the current
  user-visible run and the previous one.
- Older and resumed tool images stay unloaded until expanded with `Ctrl+O`.
- Stable Kitty image positions are cached, so unrelated redraws do not retransmit
  image payloads and the elapsed working timer continues updating normally.
- Pasted images use compact transcript references and expand on demand.
- Decoded images use a bounded in-memory cache; collapsed history is not loaded.
- Click a stored image, in a `read` row or a pasted-image preview, to open it in
  a full-screen viewer; `←`/`→` (or `h`/`l`) step through the branch's stored
  images, and `Esc`, `q` or `Enter` closes it. Clicking needs fullscreen mode,
  the default.
- Supported terminals are the same as pi's built-in image component: Kitty,
  iTerm2, Ghostty, WezTerm, and Warp.

Both pasted images and image blocks returned by tools are externalized. A pasted
image that was stored successfully is removed from the original input attachments,
so the model receives it once through the sidecar reference, not twice. The store
is content-addressed, so identical images share one blob across sessions.
If persistence fails, the original embedded image is kept rather than lost.

## Pasted image tokens

While composing, a pasted image path shows as an `[Image N]` token with
thumbnails above the editor. Click a thumbnail or press `Alt+I` for a
full-screen viewer of the prompt's images.

```text
Paste an image or image path   Insert [Image N] and show its thumbnail
Backspace / Delete on a token  Remove the whole [Image N] and its image
Alt+I or /image-store view     Open the viewer at the prompt's last image
Click a thumbnail              Open the viewer at that image (fullscreen mode)
←/→ (h/l)                      Previous / next image in the viewer
Esc, q or Enter                Close the viewer
```

A paste is converted only when it consists entirely of existing image file
paths (PNG, JPEG, GIF or WebP, up to 32 MiB): Herdr's clipboard images, files
dropped onto the terminal (quoted, backslash-escaped or `file://`), and the
temporary file Pi's own `Ctrl+V` writes. Other pastes, and pastes in bash mode
(`!`), are untouched.

A token is one highlighted block and one unit in the editor: one `Backspace`,
`Delete` or word deletion removes all of it, the arrow keys step over it, and
one undo restores it with its image. Tokens recalled from prompt history are
plain text; paste the image again.

On submit, the tokens stay in the text and the images they reference are
attached in label order, so `[Image 1]` is the first attachment. They are then
stored and previewed like any other pasted image, as described above. A token
whose file could not be read is dropped with a warning.

## Commands

```text
/image-store                       Show blob count, size, and storage path
/image-store stats                 Same as above
/image-store gc                    Delete blobs not referenced by any saved session
/image-store view                  Open the viewer for the prompt's pasted images
/image-store preview on|off        Show or hide thumbnails above the editor (default on)
/image-store rows auto|2-16        Thumbnail height in rows (default auto)
/image-store color <name|#rrggbb>  Token block color (default warning)
/image-store settings              Show the current preview settings
```

Preview settings apply immediately and are saved to
`$PI_CODING_AGENT_DIR/image-store.json`:

```json
{ "preview": true, "previewRows": "auto", "tokenColor": "warning" }
```

`auto` is a quarter of the terminal height, 4 to 8 rows. The token block uses
the theme color as its background with terminal-background text; set a Pi theme
color name or a hex value, such as `/image-store color #fe8019`. With previews
off, the highlighted tokens and the viewer still work. Commands keep
unrelated keys and refuse to overwrite malformed JSON; invalid values fall back
to the defaults.

Garbage collection scans saved sessions and always asks for confirmation before
deleting anything.

## Scope and limitations

- Only images added after the extension loads are externalized.
- Existing sessions are not rewritten automatically.
- Active images are still loaded and base64-encoded for providers; this extension
  targets local session and TUI performance, not model latency.
- Session files are no longer independently portable. Copy the image store when
  moving sessions between machines.
- Built-in HTML export and sharing do not bundle sidecars; they show an external
  image placeholder unless the session is re-embedded first.
- Compaction summaries see the persisted reference rather than the image bytes.
- Token blocks extend the editor's internal segmentation, the mechanism Pi uses
  for its own `[paste #N]` markers, on whichever editor has focus. If a Pi
  release removes it, tokens become plain text and still attach their images.
  Word wrap may break a line just before a token rather than at the space.
- Pasted-image thumbnails and the viewer need terminal image support. Herdr
  renders Kitty graphics but Pi does not detect it: set `PI_IMAGE_PROTOCOL=kitty`
  or `terminal.images: "kitty"`. Without image support, thumbnails show as labels.
- Each thumbnail row is composited into one PNG, so Pi's Kitty image caching,
  cropping and scrolling apply unchanged. A row that does not fit the terminal
  width ends with `+N more`; the viewer shows every image.
- Clicking a thumbnail needs fullscreen mode, the default. The viewer fits images
  to the terminal; it does not zoom past the screen.
- When Pi's own `Ctrl+V` path is converted, the editor cursor moves to the end.

## Dependencies

- **Runtime:** Pi extension, TUI, terminal-input, widget and image APIs.
- **npm packages:** None.
- **Depends on extensions:** None.
- **Used by extensions:** [`better-native-pi`](../better-native-pi/).
