# Auto-Account Binding — Proposal & Patch

> **Status:** proposal, NOT applied. Karena instruksi kerja, semua perubahan tertulis
> di file ini dan di `docs/`. Tinggal apply manual jika Anda setuju.

## Latar belakang

Saat ini (sebelum patch ini), **setiap** tool SSH meminta `account` (walaupun optional
di schema). Untuk tool interaktif (`send_command`, `terminal_read`, `terminal_resize`,
`terminal_close`) ini terasa seperti "login ulang" tiap call, padahal `terminal_start`
sudah membuka sesi persistent.

Tujuan auto-account binding:

- `account` jadi **opsional** di tool interaktif. AI cukup kirim `account` sekali di
  `terminal_start`; call berikutnya pakai `sessionId` saja, dan `account` di-resolve
  dari cache lokal MCP.
- Eksplisit `account` di call berikutnya **override** cache (penting saat multi-akun).
- Cache entry di-clear saat `terminal_close`.
- Tidak menyentuh `core.ts` / `ssh-connection-manager.ts` — semua logic ada di
  `src/index.ts`.

## Design

Tambah satu `Map<string, string>` di `src/index.ts`:

```ts
const sessionAccountBindings = new Map<string, string>();
// key   = sessionId
// value = accountName (atau undefined / 'cli:default' untuk mode CLI)
```

Tambah helper:

```ts
function resolveAccountForSession(sessionId: string, account?: string): string | undefined {
  // Explicit `account` selalu menang (override).
  if (account) {
    sessionAccountBindings.set(sessionId, account);
    return account;
  }
  const cached = sessionAccountBindings.get(sessionId);
  if (cached !== undefined) return cached;
  // Tidak ada binding — pakai default (mode CLI: undefined; mode vault: vault.ts
  // akan melempar error 'Vault account selection is required' seperti biasa).
  return undefined;
}
```

## Patch `src/index.ts`

### 1) Tambah cache & helper (setelah deklarasi `connectionManagers` di line 67)

```ts
const sessionAccountBindings = new Map<string, string>();

function resolveAccountForSession(sessionId: string, account?: string): string | undefined {
  if (account) {
    sessionAccountBindings.set(sessionId, account);
    return account;
  }
  const cached = sessionAccountBindings.get(sessionId);
  if (cached !== undefined) return cached;
  return undefined;
}
```

### 2) `terminal_start` (line 177-181) — simpan binding setelah sukses

```ts
async ({ account, cwd, shell, platformHint, elevated, cols, rows, env, multiSession }) => {
  const manager = await getOrCreateConnectionManager(account);
  const session = await manager.startInteractiveSession({ cwd, shell, platformHint, elevated, cols, rows, env, multiSession });
  if (session && session.sessionId) {
    // Simpan binding agar call berikutnya tidak perlu kirim `account`.
    // Pakai `account` kalau ada, else 'cli:default' untuk mode CLI.
    sessionAccountBindings.set(session.sessionId, account ?? 'cli:default');
  }
  return createTextResult(JSON.stringify(session, null, 2));
}
```

> **Catatan:** Bentuk return `startInteractiveSession` dari kode asli adalah
> `{ sessionId, initialOutput, nextSequence, reused? }`. Kalau `reused === true`,
> skip binding (sesi sudah ada di sisi server, dan mungkin sudah punya binding
> sendiri — atau belum, kalau AI pertama kali panggil `terminal_start` dengan
> `account` kosong di mode CLI). Versi paling aman: selalu overwrite binding
> dengan `account ?? 'cli:default'`.

### 3) `send_command` (line 200-204)

```ts
async ({ account, sessionId, input, appendNewline }) => {
  const resolvedAccount = resolveAccountForSession(sessionId, account);
  const manager = await getOrCreateConnectionManager(resolvedAccount);
  const result = await manager.writeInteractiveSession(sessionId, input, appendNewline ?? true);
  return createTextResult(JSON.stringify(result, null, 2));
}
```

### 4) `terminal_read` (line 225-232)

```ts
async ({ account, sessionId, sinceSequence, maxChars, waitForMs }) => {
  const resolvedAccount = resolveAccountForSession(sessionId, account);
  const manager = await getOrCreateConnectionManager(resolvedAccount);
  if (waitForMs && waitForMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitForMs));
  }
  const result = await manager.readInteractiveSession(sessionId, { sinceSequence, maxChars });
  return createTextResult(JSON.stringify(result, null, 2));
}
```

### 5) `terminal_resize` (line 248-252)

```ts
async ({ account, sessionId, cols, rows }) => {
  const resolvedAccount = resolveAccountForSession(sessionId, account);
  const manager = await getOrCreateConnectionManager(resolvedAccount);
  const result = manager.resizeInteractiveSession(sessionId, cols, rows);
  return createTextResult(JSON.stringify(result, null, 2));
}
```

### 6) `terminal_close` (line 269-273) — clear binding

```ts
async ({ account, sessionId }) => {
  const resolvedAccount = resolveAccountForSession(sessionId, account);
  const manager = await getOrCreateConnectionManager(resolvedAccount);
  const result = manager.closeInteractiveSession(sessionId);
  sessionAccountBindings.delete(sessionId);
  return createTextResult(JSON.stringify(result, null, 2));
}
```

## Update deskripsi (juga bagian dari patch)

Dengan auto-binding aktif, frasa "REQUIRED: pass `account`" di deskripsi 4 tool sesi
menjadi terlalu keras. Ganti jadi:

```
`account` is OPTIONAL once the session is created via terminal_start — it is
auto-resolved from the session binding. Pass `account` explicitly only when
working with multiple vault accounts in parallel and you need to disambiguate.
```

Dan deskripsi parameter `account` di 4 tool sesi ganti jadi:

```
account: "(Optional) Vault account name. If omitted, the account bound to
this sessionId at terminal_start time is reused. Pass explicitly to override
the binding when multiple vault accounts are in use."
```

## Backward compatibility

- `account` masih optional di schema (Zod), jadi client lama yang mengirim `account`
  di setiap call tetap jalan tanpa perubahan.
- `account` di call pertama (terminal_start) tetap wajib diisi saat mode vault
  (runtime guard di `vault.ts:70` tidak berubah).
- Perilaku `getOrCreateConnectionManager` tidak berubah.

## Yang TIDAK di-patch

- `core.ts`, `ssh-connection-manager.ts`, `vault.ts`, `upload.ts` — tidak disentuh.
- `upload_file` / `upload_content` — `account` tetap wajib (sesi stateless, tidak
  ada binding yang bisa di-reuse).

## Setelah apply

1. Jalankan `npm run build` — harusnya lulus tanpa error.
2. Test manual: buka sesi dengan `terminal_start({ account: "prod" })`, lalu
   `send_command({ sessionId: "abc", input: "ls\n" })` tanpa `account` — harusnya
   tetap resolve ke "prod".
3. `account` eksplisit di call berikutnya **override** cache (uji dengan kirim
   `account: "staging"` di `send_command` — akan error kalau sessionId tidak ada
   di store "staging", sesuai desain).

## Update配套 docs

Setelah patch di-apply, file `docs/tool-descriptions-recommendation.md` dan
`docs/tool-descriptions-snippet.md` juga perlu di-update di bagian 4-7 (tool sesi)
dengan frasa baru di atas. Diff ada di akhir file ini.

---

## Diff for `docs/tool-descriptions-recommendation.md` (tool 4-7)

Cari blok "**REQUIRED:** pass `account` (vault account name) when the server runs
with --vault …" di tiap tool sesi dan ganti jadi:

```
> **AUTO-BINDING:** Once you open a session with `terminal_start`, you usually do
> NOT need to pass `account` on `send_command` / `terminal_read` / `terminal_resize` /
> `terminal_close` — the MCP remembers which account owns the session and reuses it.
> Pass `account` explicitly only when you are juggling multiple vault accounts in
> parallel and need to disambiguate. `terminal_start` itself still requires `account`
> in --vault mode (the existing runtime guard will throw if missing).
```

Dan `Parameter descriptions` untuk `account` di 4 tool sesi ganti jadi:

```
- `account`: "(Optional) Vault account name. If omitted, the account bound to this
  sessionId at terminal_start time is reused automatically. Pass explicitly to override
  the binding when working with multiple vault accounts."
```

## Diff for `docs/tool-descriptions-snippet.md` (tool 4-7)

Snippet description tiap `server.tool(...)` sesi ganti frasa "REQUIRED: pass `account` …"
jadi:

```
'AUTO-BINDING: once the session is opened with terminal_start, you usually do NOT ' +
'need to pass `account` on subsequent session calls — the MCP reuses the account ' +
'that opened the session. Pass `account` explicitly only to override the binding ' +
'when working with multiple vault accounts in parallel. terminal_start itself still ' +
'requires `account` in --vault mode. ',
```
