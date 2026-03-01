# Google Drive + VeilDoc Encryption Backend

## Setup Instructions

### 1. Install Python Dependencies

The VeilDoc encryption system requires Python 3.7+ and PyMuPDF for PDF support:

```bash
cd block_copy
pip install -r requirements.txt
```

Verify installation:

```bash
python3 veildoc.py --help
python3 unveildoc.py --help
```

### 2. Configure Google Drive Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Drive API
4. Create a service account with Drive access permissions
5. Download the service account JSON key file
6. Place it in `config/google-service-account.json`

Required OAuth Scopes:
- `https://www.googleapis.com/auth/drive`

For organization-wide access, set up domain-wide delegation.

### 3. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and configure:

```bash
# Supabase (required)
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Google Drive (required)
GOOGLE_SERVICE_ACCOUNT_PATH=./config/google-service-account.json
GOOGLE_DRIVE_WEBHOOK_URL=https://your-domain.com/api/drive/webhook

# API Server
API_PORT=3000
API_HOST=0.0.0.0

# VeilDoc Configuration
VEILDOC_DEFAULT_MODE=pattern
PYTHON_EXECUTABLE=python3
```

### 4. Run Database Migrations

Apply the Supabase migrations to add encryption fields:

```bash
# Via Supabase Dashboard
# 1. Go to SQL Editor
# 2. Paste contents of supabase/migrations/20260228000001_add_encryption_fields.sql
# 3. Run the migration

# OR via Supabase CLI
supabase db push
```

### 5. Start the API Server

Development mode (with hot reload):

```bash
npm run dev:api
```

Production mode:

```bash
npm run build
npm run start:api
```

The server will start on `http://localhost:3000` (or your configured port).

## API Endpoints

### List Google Drive Files

```bash
GET /api/drive/files?folderId=xxx&pageToken=yyy
```

Returns paginated list of files from Google Drive.

### Encrypt Files

```bash
POST /api/drive/encrypt
Content-Type: application/json

{
  "fileIds": ["file-id-1", "file-id-2"],
  "mode": "pattern",
  "replaceOriginal": false
}
```

Starts an encryption job and returns a job ID for tracking.

### Check Encryption Status

```bash
GET /api/drive/status/:jobId
```

Returns the current status of an encryption job.

### Disable Encryption

```bash
POST /api/drive/disable-encryption
Content-Type: application/json

{
  "fileId": "file-id"
}
```

Stops monitoring and automatic re-encryption for a file.

### List Encrypted Documents

```bash
GET /api/documents?encryption_enabled=true&status=encrypted
```

Returns documents from Supabase with encryption metadata.

### Webhook Endpoint

```bash
POST /api/drive/webhook
```

Receives Google Drive change notifications (configured automatically).

## Webhook Setup for Production

For continuous monitoring, the webhook endpoint must be publicly accessible:

1. Deploy to a cloud provider (Railway, Render, Fly.io, etc.)
2. Configure SSL/TLS certificate
3. Set `GOOGLE_DRIVE_WEBHOOK_URL` to your public endpoint
4. Verify domain ownership in [Google Search Console](https://search.google.com/search-console)

Webhooks expire after ~24 hours and are automatically renewed by the background task.

## How It Works

### Initial Encryption Flow

1. User selects files in frontend
2. Frontend calls `POST /api/drive/encrypt`
3. Backend downloads file from Google Drive
4. VeilDoc encrypts the document (Python script)
5. Encrypted file is uploaded back to Drive
6. Webhook is registered for file monitoring
7. Metadata is stored in Supabase

### Continuous Monitoring Flow

1. User edits file in Google Drive
2. Google sends webhook notification to backend
3. Backend detects file modification
4. File is automatically re-encrypted
5. Encrypted version replaces the file in Drive
6. Database is updated with new timestamp

### Webhook Renewal

- Webhooks expire after 24 hours
- Background task runs every 12 hours
- Expiring webhooks are automatically renewed
- No manual intervention required

## File Support

Supported file formats:
- **DOCX** (.docx) - Microsoft Word documents
- **PDF** (.pdf) - PDF documents

Encryption modes:
- **Pattern mode** (default) - Encrypts only sensitive patterns (SSN, credit cards, emails, etc.)
- **Full mode** - Encrypts entire document (recommended for intellectual property)

## Troubleshooting

### Python script not found

Ensure the `block_copy` directory exists and contains `veildoc.py`:

```bash
ls block_copy/veildoc.py
```

### Service account authentication failed

Verify your service account JSON key:

```bash
cat config/google-service-account.json
```

Ensure the file has the correct structure and the service account has Drive API access.

### Webhook not receiving notifications

1. Ensure your webhook URL is publicly accessible via HTTPS
2. Verify domain ownership in Google Search Console
3. Check that webhooks are not being blocked by firewall/security rules
4. Review webhook expiration times in database

### Supabase connection failed

Verify your Supabase credentials:

```bash
echo $SUPABASE_URL
echo $SUPABASE_SERVICE_KEY
```

Ensure you're using the **service role key** (not the anon key).

## Development vs Production

### Development (Local)

- Use ngrok to expose local webhook endpoint
- Test with personal Google account
- Single instance, no load balancing needed

### Production

- Deploy to cloud provider with static IP
- Configure proper SSL/TLS certificates
- Set up monitoring and logging
- Configure rate limiting
- Add authentication middleware
- Set up error alerting (Sentry, etc.)

## Security Considerations

- Service account key contains sensitive credentials - never commit to git
- Use environment variables for all secrets
- Validate all user inputs on API endpoints
- Rate limit API endpoints to prevent abuse
- Verify webhook signatures on incoming requests
- Sanitize file paths to prevent directory traversal
- Use HTTPS for all webhook communications

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Frontend  │────▶│  Express API │────▶│ Google Drive │
└─────────────┘     └──────────────┘     └──────────────┘
                           │                      │
                           │                      ▼
                           │            ┌──────────────────┐
                           │            │ Webhook Monitor  │
                           │            └──────────────────┘
                           │                      │
                           ▼                      ▼
                    ┌──────────────┐     ┌──────────────┐
                    │   Supabase   │     │   VeilDoc    │
                    │   Database   │     │   (Python)   │
                    └──────────────┘     └──────────────┘
```

## License

MIT
