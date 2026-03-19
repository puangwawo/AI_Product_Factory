const path       = require('path');
const fs         = require('fs');
const { google } = require('googleapis');
const OpenAI     = require('openai');
const { Client } = require('@notionhq/client');

const SPREADSHEET_ID  = process.env.GOOGLE_SHEETS_ID || '';
const SHEET_NAME      = 'Products';
const NOTION_DB_ID    = process.env.NOTION_DATABASE_ID || '';

const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const notion  = new Client({ auth: process.env.NOTION_API_KEY });

// ─── Google Auth ──────────────────────────────────────────────────────────────
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

// ─── Keyword Pool ─────────────────────────────────────────────────────────────
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

// ─── OpenAI Generate ──────────────────────────────────────────────────────────
async function generateProductWithAI(keyword) {
  console.log(`🤖 Sending to OpenAI: "${keyword}"`);
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `You are a digital product expert. Given keyword: "${keyword}", return ONLY JSON:
{"product_idea":"...","product_type":"...","bundle_content":"...","title":"...","tags":"...","description":"..."}
Rules: JSON only, no markdown, title max 80 chars, tags = 13 comma-separated keywords.`
    }],
    temperature: 0.7,
  });
  const raw = response.choices[0].message.content.trim();
  let product;
  try { product = JSON.parse(raw); }
  catch { const m = raw.match(/\{[\s\S]*\}/); product = JSON.parse(m[0]); }
  console.log(`✅ Generated: "${product.title}"`);
  return product;
}

// ─── Google Sheets Insert ─────────────────────────────────────────────────────
async function insertToGoogleSheets(keyword, product) {
  console.log('📊 Inserting to Google Sheets...');
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const createdAt = new Date().toISOString().replace('T',' ').slice(0,19);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:I`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      keyword, product.product_idea, product.product_type,
      product.bundle_content, product.title, product.tags,
      product.description, 'idea_generated', createdAt
    ]]},
  });
  console.log(`✅ Sheets row inserted: "${product.title}"`);
}

// ─── Notion Insert ────────────────────────────────────────────────────────────
async function insertToNotion(keyword, product) {
  if (!NOTION_DB_ID) {
    console.log('⚠️  NOTION_DATABASE_ID not set, skipping Notion');
    return;
  }
  console.log('📝 Creating Notion page...');

  await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: {
      title: {
        title: [{ text: { content: product.title || keyword } }]
      },
      keyword: {
        rich_text: [{ text: { content: keyword } }]
      },
      product_idea: {
        rich_text: [{ text: { content: product.product_idea || '' } }]
      },
      product_type: {
        select: { name: product.product_type || 'Other' }
      },
      bundle_content: {
        rich_text: [{ text: { content: product.bundle_content || '' } }]
      },
      tags: {
        rich_text: [{ text: { content: product.tags || '' } }]
      },
      description: {
        rich_text: [{ text: { content: product.description || '' } }]
      },
      status: {
        select: { name: 'idea_generated' }
      },
      created_at: {
        date: { start: new Date().toISOString() }
      },
    },
  });

  console.log(`✅ Notion page created: "${product.title}"`);
}

// ─── Headers Check ────────────────────────────────────────────────────────────
async function ensureSheetHeaders() {
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:I1`,
  });
  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:I1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['keyword','product_idea','product_type',
        'bundle_content','title','tags','description','status','created_at']] },
    });
    console.log('📝 Headers written');
  }
}

// ─── Main Pipeline ────────────────────────────────────────────────────────────
async function runAutomation() {
  const start = Date.now();
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Started at ${new Date().toLocaleString()}`);

  await ensureSheetHeaders();
  const keyword = generateKeyword();
  const product = await generateProductWithAI(keyword);

  // Jalankan Google Sheets & Notion bersamaan (parallel)
  await Promise.all([
    insertToGoogleSheets(keyword, product),
    insertToNotion(keyword, product),
  ]);

  console.log(`🎉 Done in ${((Date.now()-start)/1000).toFixed(1)}s\n`);
  return { keyword, product };
}

module.exports = { runAutomation };
