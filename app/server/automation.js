const path       = require('path');
const fs         = require('fs');
const { google } = require('googleapis');
const Anthropic  = require('@anthropic-ai/sdk');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID || '';
const SHEET_NAME     = 'Products';
const HEADER_ROW = [[
  'keyword', 'product_idea', 'product_type',
  'bundle_content', 'title', 'tags', 'description', 'status', 'created_at',
]];

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let _authClient = null;
async function getAuthClient() {
  if (_authClient) return _authClient;
  const credentialsEnv = process.env.GOOGLE_CREDENTIALS;
  if (!credentialsEnv) throw new Error('GOOGLE_CREDENTIALS is not set');
  const credentials = credentialsEnv.trim().startsWith('{')
    ? JSON.parse(credentialsEnv)
    : JSON.parse(fs.readFileSync(path.resolve(__dirname, credentialsEnv), 'utf8'));
  _authClient = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  console.log('✅ Google Sheets auth ready');
  return _authClient;
}

function getSheetRange(range) {
  return `'${SHEET_NAME.replace(/'/g, "''")}'!${range}`;
}

const KEYWORD_POOL = [
  'adhd planner','budget planner','meal planner','habit tracker',
  'gratitude journal','anxiety journal','fitness tracker','study planner',
  'social media content calendar','business expense tracker',
  'self-care planner','reading tracker','digital vision board',
  'notion dashboard template','resume template',
];

function generateKeyword() {
  const keyword = KEYWORD_POOL[Math.floor(Math.random() * KEYWORD_POOL.length)];
  console.log(`🔍 Keyword: "${keyword}"`);
  return keyword;
}

async function generateProductWithAI(keyword) {
  console.log(`🤖 Sending to Claude: "${keyword}"`);
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are a digital product expert. Given keyword: "${keyword}", return ONLY a JSON object:
{"product_idea":"...","product_type":"...","bundle_content":"...","title":"...","tags":"...","description":"..."}
Rules: JSON only, no markdown, title max 80 chars, tags = 13 comma-separated keywords.`
    }],
  });
  const raw = message.content[0].text.trim();
  let product;
  try { product = JSON.parse(raw); }
  catch { const m = raw.match(/\{[\s\S]*\}/); product = JSON.parse(m[0]); }
  console.log(`✅ Generated: "${product.title}"`);
  return product;
}

async function ensureSheetExists(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties.title',
  });
  const sheetExists = spreadsheet.data.sheets?.some(
    ({ properties }) => properties?.title === SHEET_NAME,
  );

  if (!sheetExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
    console.log(`🗂️ Sheet created: "${SHEET_NAME}"`);
  }
}

async function insertToGoogleSheets(keyword, product) {
  console.log('📊 Inserting to Google Sheets...');
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const createdAt = new Date().toISOString().replace('T',' ').slice(0,19);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: getSheetRange('A:I'),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      keyword, product.product_idea, product.product_type,
      product.bundle_content, product.title, product.tags,
      product.description, 'idea_generated', createdAt,
    ]]},
  });
  console.log(`✅ Row inserted: "${product.title}"`);
}

async function ensureSheetHeaders() {
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  await ensureSheetExists(sheets);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: getSheetRange('A1:I1'),
  });

  if (!res.data.values || res.data.values.length === 0 || res.data.values[0].every(cell => !cell)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: getSheetRange('A1:I1'),
      valueInputOption: 'RAW',
      requestBody: { values: HEADER_ROW },
    });
    console.log('📝 Headers written');
  }
}

async function runAutomation() {
  const start = Date.now();
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Started at ${new Date().toLocaleString()}`);
  await ensureSheetHeaders();
  const keyword = generateKeyword();
  const product = await generateProductWithAI(keyword);
  await insertToGoogleSheets(keyword, product);
  console.log(`🎉 Done in ${((Date.now()-start)/1000).toFixed(1)}s\n`);
  return { keyword, product };
}

module.exports = { runAutomation, getSheetRange, ensureSheetExists, ensureSheetHeaders };
