/**
 * VeilDoc Integration Module
 * 
 * Provides Node.js wrapper functions for calling the VeilDoc Python scripts
 * to encrypt and decrypt documents with LLM-resistant obfuscation.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

// ── Configuration ────────────────────────────────────────────

const BLOCK_COPY_DIR = join(__dirname, '../../block_copy');
const VEILDOC_SCRIPT = join(BLOCK_COPY_DIR, 'veildoc.py');
const UNVEILDOC_SCRIPT = join(BLOCK_COPY_DIR, 'unveildoc.py');
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE || 'python3';

// ── Types ────────────────────────────────────────────────────

export type EncryptionMode = 'full' | 'pattern';

export interface EncryptionResult {
  outputPath: string;
  sidecarPath: string;
  metadata: SidecarMetadata;
}

export interface SidecarMetadata {
  version: string;
  input_file: string;
  output_file: string;
  seed: number;
  mode: string;
  timestamp: string;
  obfuscation_stats?: {
    total_chars?: number;
    obfuscated_chars?: number;
    patterns_found?: number;
  };
  [key: string]: any;
}

export interface DecryptionResult {
  outputPath: string;
  success: boolean;
}

// ── Supported MIME Types ─────────────────────────────────────

const SUPPORTED_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/pdf', // .pdf
];

const MIME_TO_EXTENSION: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/pdf': '.pdf',
};

// ── Main Functions ───────────────────────────────────────────

/**
 * Encrypt a document using VeilDoc Python script
 * 
 * @param inputPath - Path to the input document (DOCX or PDF)
 * @param mode - Encryption mode: 'full' (entire document) or 'pattern' (sensitive patterns only)
 * @param seed - Optional seed for deterministic obfuscation
 * @returns Promise resolving to encryption result with output paths
 */
export async function encryptDocument(
  inputPath: string,
  mode: EncryptionMode = 'pattern',
  seed?: number
): Promise<EncryptionResult> {
  // Validate input file exists
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  // Validate VeilDoc script exists
  if (!existsSync(VEILDOC_SCRIPT)) {
    throw new Error(`VeilDoc script not found at: ${VEILDOC_SCRIPT}`);
  }

  // Build command arguments
  const args = [VEILDOC_SCRIPT, inputPath];
  
  if (mode === 'full') {
    args.push('--full');
  }
  
  if (seed !== undefined) {
    args.push('--seed', seed.toString());
  }

  // Execute Python script
  const { stdout, stderr, exitCode } = await executeProcess(PYTHON_EXECUTABLE, args);

  // Check for errors
  if (exitCode !== 0) {
    throw new Error(`VeilDoc encryption failed (exit code ${exitCode}): ${stderr}`);
  }

  // Determine output paths (VeilDoc appends .veiled before extension)
  const outputPath = inputPath.replace(/(\.[^.]+)$/, '.veiled$1');
  const sidecarPath = outputPath + '.veildoc.json';

  // Validate output files were created
  if (!existsSync(outputPath)) {
    throw new Error(`Expected output file not found: ${outputPath}`);
  }
  
  if (!existsSync(sidecarPath)) {
    throw new Error(`Expected sidecar file not found: ${sidecarPath}`);
  }

  // Parse sidecar JSON
  const metadata = await parseSidecarJson(sidecarPath);

  return {
    outputPath,
    sidecarPath,
    metadata,
  };
}

/**
 * Decrypt a document using UnveilDoc Python script
 * 
 * @param inputPath - Path to the encrypted document (.veiled.docx or .veiled.pdf)
 * @param sidecarPath - Path to the sidecar JSON file (optional, auto-detected if not provided)
 * @returns Promise resolving to decryption result
 */
export async function decryptDocument(
  inputPath: string,
  sidecarPath?: string
): Promise<DecryptionResult> {
  // Validate input file exists
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  // Validate UnveilDoc script exists
  if (!existsSync(UNVEILDOC_SCRIPT)) {
    throw new Error(`UnveilDoc script not found at: ${UNVEILDOC_SCRIPT}`);
  }

  // Build command arguments
  const args = [UNVEILDOC_SCRIPT, inputPath];
  
  if (sidecarPath) {
    args.push('--sidecar', sidecarPath);
  }

  // Execute Python script
  const { stdout, stderr, exitCode } = await executeProcess(PYTHON_EXECUTABLE, args);

  // Check for errors
  if (exitCode !== 0) {
    throw new Error(`UnveilDoc decryption failed (exit code ${exitCode}): ${stderr}`);
  }

  // Determine output path (UnveilDoc removes .veiled from filename)
  const outputPath = inputPath.replace('.veiled', '');

  return {
    outputPath,
    success: existsSync(outputPath),
  };
}

/**
 * Parse VeilDoc sidecar JSON file
 * 
 * @param sidecarPath - Path to the .veildoc.json file
 * @returns Promise resolving to parsed metadata
 */
export async function parseSidecarJson(sidecarPath: string): Promise<SidecarMetadata> {
  try {
    const content = await readFile(sidecarPath, 'utf-8');
    const metadata = JSON.parse(content);
    return metadata;
  } catch (error) {
    throw new Error(`Failed to parse sidecar JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if Python and required dependencies are installed
 * 
 * @returns Promise resolving to dependency check result
 */
export async function checkPythonDependencies(): Promise<{
  pythonInstalled: boolean;
  pythonVersion?: string;
  pymupdfInstalled: boolean;
  veildocScriptExists: boolean;
  unveildocScriptExists: boolean;
}> {
  let pythonInstalled = false;
  let pythonVersion: string | undefined;
  let pymupdfInstalled = false;

  // Check Python installation
  try {
    const { stdout } = await executeProcess(PYTHON_EXECUTABLE, ['--version']);
    pythonInstalled = true;
    pythonVersion = stdout.trim();
  } catch (error) {
    pythonInstalled = false;
  }

  // Check PyMuPDF installation (for PDF support)
  if (pythonInstalled) {
    try {
      await executeProcess(PYTHON_EXECUTABLE, ['-c', 'import fitz']);
      pymupdfInstalled = true;
    } catch (error) {
      pymupdfInstalled = false;
    }
  }

  return {
    pythonInstalled,
    pythonVersion,
    pymupdfInstalled,
    veildocScriptExists: existsSync(VEILDOC_SCRIPT),
    unveildocScriptExists: existsSync(UNVEILDOC_SCRIPT),
  };
}

/**
 * Get list of supported MIME types for encryption
 * 
 * @returns Array of supported MIME types
 */
export function getSupportedMimeTypes(): string[] {
  return [...SUPPORTED_MIME_TYPES];
}

/**
 * Check if a MIME type is supported for encryption
 * 
 * @param mimeType - MIME type to check
 * @returns True if supported, false otherwise
 */
export function isMimeTypeSupported(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.includes(mimeType);
}

/**
 * Get file extension for a MIME type
 * 
 * @param mimeType - MIME type
 * @returns File extension (e.g., '.docx', '.pdf') or undefined if not supported
 */
export function getExtensionForMimeType(mimeType: string): string | undefined {
  return MIME_TO_EXTENSION[mimeType];
}

// ── Helper Functions ─────────────────────────────────────────

/**
 * Execute a process and capture output
 * 
 * @param command - Command to execute
 * @param args - Command arguments
 * @returns Promise resolving to process output
 */
function executeProcess(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);
    
    let stdout = '';
    let stderr = '';
    
    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    process.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });
    
    process.on('error', (error) => {
      reject(new Error(`Failed to execute process: ${error.message}`));
    });
  });
}

// ── Exports ──────────────────────────────────────────────────

export default {
  encryptDocument,
  decryptDocument,
  parseSidecarJson,
  checkPythonDependencies,
  getSupportedMimeTypes,
  isMimeTypeSupported,
  getExtensionForMimeType,
};
