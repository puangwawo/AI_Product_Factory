const path       = require('path');
const fs         = require('fs');
const { google } = require('googleapis');
const OpenAI     = require('openai');
const { Client } = require('@notionhq/client');

const SPREADSHEET_ID  = process.env.GOOGLE_SHEETS_ID || '';
const SHEET_NAME      = 'Products';

const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const notion  = new Client({ auth: process.env.NOTION_API_KEY });

function normalizeNotionId(value) {
  if (!value) return '';

  const trimmed = value.trim();
  const uuidMatch = trimmed.match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (!uuidMatch) return '';

  const compact = uuidMatch[0].replace(/-/g, '').toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join('-');
}

const NOTION_DB_ID = normalizeNotionId(process.env.NOTION_DATABASE_ID || '');
let _notionDatabase = null;

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

async function getNotionDatabase() {
  if (_notionDatabase) return _notionDatabase;

  _notionDatabase = await notion.databases.retrieve({ database_id: NOTION_DB_ID });
  return _notionDatabase;
}

function normalizePropertyName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildTextProperty(type, value) {
  const content = String(value || '').trim();
  if (!content) return null;

  if (type === 'rich_text') {
    return { rich_text: [{ text: { content } }] };
  }

  if (type === 'title') {
    return { title: [{ text: { content } }] };
  }

  return null;
}

function buildSelectProperty(schema, value) {
  const content = String(value || '').trim();
  if (!content) return null;

  const options = schema[typeof schema.select === 'object' ? 'select' : 'status']?.options || [];
  const exactMatch = options.find(option => option.name === content);
  const caseInsensitiveMatch = options.find(option => option.name.toLowerCase() === content.toLowerCase());
  const selected = exactMatch || caseInsensitiveMatch;

  if (schema.type === 'status') {
    const fallback = selected || options[0];
    return fallback ? { status: { name: fallback.name } } : null;
  }

  return { select: selected ? { name: selected.name } : { name: content } };
}

function buildDateProperty(value) {
  if (!value) return null;
  return { date: { start: value } };
}

function matchProperty(properties, ...aliases) {
  const normalizedAliases = aliases.map(normalizePropertyName);
  return Object.entries(properties).find(([name]) => normalizedAliases.includes(normalizePropertyName(name)));
}

function buildNotionProperties(database, keyword, product) {
  const properties = {};
  const schema = database.properties || {};
  const nowIso = new Date().toISOString();

  const titleEntry = Object.entries(schema).find(([, config]) => config.type === 'title');
  if (!titleEntry) {
    throw new Error('Notion database requires one title property.');
  }
  properties[titleEntry[0]] = buildTextProperty('title', product.title || keyword);

  const mappings = [
    { aliases: ['keyword'], value: keyword, types: ['rich_text', 'title'] },
    { aliases: ['product_idea', 'product idea', 'idea'], value: product.product_idea, types: ['rich_text'] },
    { aliases: ['product_type', 'product type', 'type'], value: product.product_type, types: ['select', 'rich_text'] },
    { aliases: ['bundle_content', 'bundle content', 'content'], value: product.bundle_content, types: ['rich_text'] },
    { aliases: ['tags', 'keywords'], value: product.tags, types: ['rich_text', 'multi_select'] },
    { aliases: ['description', 'desc'], value: product.description, types: ['rich_text'] },
    { aliases: ['status'], value: 'idea_generated', types: ['status', 'select'] },
    { aliases: ['created_at', 'created at', 'date'], value: nowIso, types: ['date'] },
  ];

  for (const mapping of mappings) {
    const match = matchProperty(schema, ...mapping.aliases);
    if (!match) continue;

    const [propertyName, propertySchema] = match;
    let propertyValue = null;

    if (propertySchema.type === 'title' || propertySchema.type === 'rich_text') {
      propertyValue = buildTextProperty(propertySchema.type, mapping.value);
    } else if (propertySchema.type === 'select' || propertySchema.type === 'status') {
      propertyValue = buildSelectProperty(propertySchema, mapping.value);
    } else if (propertySchema.type === 'date') {
      propertyValue = buildDateProperty(mapping.value);
    } else if (propertySchema.type === 'multi_select') {
      const items = String(mapping.value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(name => ({ name }));
      if (items.length > 0) propertyValue = { multi_select: items };
    }

    if (propertyValue) {
      properties[propertyName] = propertyValue;
    }
  }

  return properties;
}

// ─── Notion Insert ────────────────────────────────────────────────────────────
async function insertToNotion(keyword, product) {
  if (!process.env.NOTION_DATABASE_ID) {
    console.log('⚠️  NOTION_DATABASE_ID not set, skipping Notion');
    return;
  }

  if (!NOTION_DB_ID) {
    throw new Error('NOTION_DATABASE_ID must be a Notion database ID or database URL that contains a valid UUID');
  }
  console.log('📝 Creating Notion page...');

  const database = await getNotionDatabase();
  const properties = buildNotionProperties(database, keyword, product);

  await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties,
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

  await Promise.all([
    insertToGoogleSheets(keyword, product),
    insertToNotion(keyword, product),
  ]);

  console.log(`🎉 Done in ${((Date.now()-start)/1000).toFixed(1)}s\n`);
  return { keyword, product };
}

module.exports = { runAutomation, buildNotionProperties, normalizePropertyName };
