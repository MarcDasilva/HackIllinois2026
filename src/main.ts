/**
 * Main entry point for the API server
 * 
 * Starts the Express server with Google Drive + VeilDoc encryption endpoints
 */

// Load .env before any other imports that read process.env (e.g. api/server creates Supabase client at load time)
import 'dotenv/config';

import { startServer } from './api/server';

// Start the server
startServer().catch((error) => {
  console.error('[main] Fatal error starting server:', error);
  process.exit(1);
});
