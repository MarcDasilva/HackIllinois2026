/**
 * src/server.ts
 *
 * Express HTTP server — Google Drive transfer API.
 *
 * Endpoints:
 *
 *   GET  /health
 *     Returns 200 + JSON status (useful for load balancer health checks).
 *
 *   GET  /oauth/google
 *     Redirects the user to Google's OAuth consent page.
 *     Query params:
 *       user_id (required) — Supabase user ID to associate the token with.
 *
 *   GET  /oauth/callback
 *     Google redirects here after consent. Exchanges the code for tokens
 *     and stores them in Supabase. Redirects to OAUTH_SUCCESS_REDIRECT_URI
 *     (or returns JSON if the env var is not set).
 *
 *   POST /transfer
 *     Trigger a Google Drive file transfer for a document.
 *     Body (JSON):
 *       {
 *         "document_id":       "<uuid>",        — documents.id in Supabase
 *         "target_folder_id":  "<drive-folder>",— destination Drive folder ID
 *         "user_id":           "<uuid>"         — Supabase user who owns the token
 *       }
 *     Response:
 *       202 Accepted  — transfer kicked off (result in body)
 *       400 Bad Request — missing/invalid body fields
 *       500 Internal Server Error — unexpected failure
 *
 * Environment variables:
 *   SERVER_PORT              — Port to listen on (default: 3000)
 *   GOOGLE_CLIENT_ID         — OAuth 2.0 client ID
 *   GOOGLE_CLIENT_SECRET     — OAuth 2.0 client secret
 *   GOOGLE_REDIRECT_URI      — Must match registration in Google Cloud Console
 *   OAUTH_SUCCESS_REDIRECT   — Where to send users after successful OAuth
 *                              (default: none — returns JSON)
 */

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { getAuthUrl, exchangeCodeAndStore } from "./googleDrive";
import { executeTransfer } from "./transferJob";
import { validateSupabaseConnection } from "./supabase";

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ─── Types ────────────────────────────────────────────────────────────────────

interface TransferRequestBody {
  document_id?: string;
  target_folder_id?: string;
  user_id?: string;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Simple liveness check.
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

/**
 * GET /oauth/google
 * Redirect user to Google's OAuth consent page.
 *
 * Requires ?user_id=<supabase-uuid> so we know who to store the token for.
 */
app.get("/oauth/google", (req: Request, res: Response) => {
  const userId = req.query["user_id"];

  if (!userId || typeof userId !== "string") {
    res.status(400).json({
      error: "Missing required query parameter: user_id",
      hint: "Pass the Supabase user UUID as ?user_id=<uuid>",
    });
    return;
  }

  // Embed the user_id in the OAuth state parameter so we can retrieve it
  // in the callback without relying on sessions.
  const state = Buffer.from(JSON.stringify({ user_id: userId })).toString("base64url");

  try {
    const authUrl = getAuthUrl();
    // Append state to the generated URL.
    const urlWithState = `${authUrl}&state=${encodeURIComponent(state)}`;
    res.redirect(urlWithState);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /oauth/callback
 * Google redirects here after consent with ?code=...&state=...
 * Exchange code → tokens, store in Supabase, redirect or return JSON.
 */
app.get("/oauth/callback", async (req: Request, res: Response) => {
  const code = req.query["code"];
  const state = req.query["state"];
  const errorParam = req.query["error"];

  // User denied access.
  if (errorParam) {
    res.status(400).json({ error: `OAuth denied: ${errorParam}` });
    return;
  }

  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Missing 'code' from Google OAuth callback." });
    return;
  }

  // Decode state to get user_id.
  let userId: string;

  try {
    const stateStr = Buffer.from(String(state), "base64url").toString("utf8");
    const parsed = JSON.parse(stateStr) as { user_id?: string };

    if (!parsed.user_id) throw new Error("state missing user_id");
    userId = parsed.user_id;
  } catch {
    res.status(400).json({ error: "Invalid or missing state parameter." });
    return;
  }

  try {
    await exchangeCodeAndStore(code, userId);

    const successRedirect = process.env.OAUTH_SUCCESS_REDIRECT;

    if (successRedirect) {
      res.redirect(successRedirect);
    } else {
      res.json({
        success: true,
        message: "Google Drive connected successfully.",
        user_id: userId,
      });
    }
  } catch (err) {
    console.error("[server] OAuth callback error:", String(err));
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /transfer
 * Trigger a Drive file transfer for a document.
 *
 * Sets transfer_status = 'pending' first, then executes the transfer
 * synchronously (so the response reflects the final outcome).
 *
 * For very large files or high-volume systems, consider offloading this
 * to a queue — but for hackathon/MVP scale, sync is fine.
 */
app.post("/transfer", async (req: Request, res: Response) => {
  const body = req.body as TransferRequestBody;

  // ── Validate required fields ──────────────────────────────────────────────
  const missing: string[] = [];

  if (!body.document_id) missing.push("document_id");
  if (!body.target_folder_id) missing.push("target_folder_id");
  if (!body.user_id) missing.push("user_id");

  if (missing.length > 0) {
    res.status(400).json({
      error: `Missing required fields: ${missing.join(", ")}`,
      expected: {
        document_id: "UUID string — documents.id in Supabase",
        target_folder_id: "Google Drive folder ID (destination)",
        user_id: "Supabase user UUID (must have Google Drive connected)",
      },
    });
    return;
  }

  console.log(
    `[server] POST /transfer — doc=${body.document_id}  target=${body.target_folder_id}  user=${body.user_id}`
  );

  try {
    const result = await executeTransfer({
      documentId: body.document_id!,
      targetFolderId: body.target_folder_id!,
      userId: body.user_id!,
    });

    const statusCode = result.status === "done" ? 200
      : result.status === "error" ? 500
      : 202;

    res.status(statusCode).json(result);
  } catch (err) {
    // executeTransfer is designed to never throw, but guard anyway.
    console.error("[server] Unexpected error in POST /transfer:", String(err));
    res.status(500).json({ error: String(err) });
  }
});

// ─── 404 catch-all ───────────────────────────────────────────────────────────

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // Validate Supabase is reachable before accepting traffic.
  await validateSupabaseConnection();

  const port = parseInt(process.env.SERVER_PORT ?? "3000", 10);

  app.listen(port, () => {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  LAVA Drive Transfer Server");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Listening on  : http://localhost:${port}`);
    console.log(`  Health check  : GET  /health`);
    console.log(`  Connect Drive : GET  /oauth/google?user_id=<uuid>`);
    console.log(`  Transfer file : POST /transfer`);
    console.log("═══════════════════════════════════════════════════════════════");
  });
}

start().catch((err) => {
  console.error("[server] Fatal startup error:", String(err));
  process.exit(1);
});
