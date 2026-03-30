const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "store.json");
const sqliteFile = path.join(dataDir, "store.sqlite");
const STORAGE_PROVIDERS = Object.freeze({
  JSON: "JSON",
  SQLITE: "SQLITE",
  SUPABASE: "SUPABASE",
});
const requestedStorageProvider = String(process.env.STORAGE_PROVIDER || STORAGE_PROVIDERS.SQLITE)
  .trim()
  .toUpperCase();
const ACTIVE_STORAGE_PROVIDER = Object.values(STORAGE_PROVIDERS).includes(requestedStorageProvider)
  ? requestedStorageProvider
  : STORAGE_PROVIDERS.SQLITE;
const DELIVERY_FEES = Object.freeze({
  MANILA: 300,
  LUZON: 500,
  VISAYAS: 1000,
  MINDANAO: 2000,
});
const CHECKOUT_MODES = Object.freeze({
  GUEST: "GUEST",
  CREATE_ACCOUNT: "CREATE_ACCOUNT",
});
const ORDER_STATUSES = Object.freeze({
  PENDING: "PENDING",
  PAID: "PAID",
  FOR_DELIVERY: "FOR_DELIVERY",
  RECEIVED: "RECEIVED",
});
const ITEM_CATEGORIES = Object.freeze({
  CLOTHES: "Clothes",
  BAGS: "Bags",
  MISCELLANEOUS: "Miscellaneous",
});
const ORDER_STATUS_TRANSITIONS = Object.freeze({
  [ORDER_STATUSES.PENDING]: [ORDER_STATUSES.PAID],
  [ORDER_STATUSES.PAID]: [ORDER_STATUSES.FOR_DELIVERY],
  [ORDER_STATUSES.FOR_DELIVERY]: [ORDER_STATUSES.RECEIVED],
  [ORDER_STATUSES.RECEIVED]: [],
});
const DEFAULT_ADMIN_NOTIFICATION_SETTINGS = Object.freeze({
  enabled: true,
  newOrderEmail: "",
});
const DEFAULT_SMTP_SETTINGS = Object.freeze({
  host: "",
  port: null,
  secure: null,
  user: "",
  pass: "",
  fromEmail: "",
  fromName: "",
  rejectUnauthorized: null,
});
const DEFAULT_FACEBOOK_AUTO_POST = Object.freeze({
  enabled: false,
  appId: "",
  appSecret: "",
  loginRedirectUri: "",
  userAccessToken: "",
  selectedPageId: "",
  availablePages: [],
  pageId: "",
  pageName: "",
  pageAccessToken: "",
  baseUrl: "http://localhost:3002",
  timezone: "Asia/Manila",
  hour: 9,
  minute: 0,
  itemsPerPost: 3,
  lastPostStatus: "IDLE",
  lastPostMessage: "",
  lastPostId: "",
  lastPostedAt: null,
  lastAttemptAt: null,
  lastTriggeredBy: "",
});
const DEFAULT_PAYMONGO_CHECKOUT_LINKS = Object.freeze({
  step: 50,
  links: {},
});

const initialData = {
  meta: {
    nextOrderId: 1,
    nextUserId: 1,
    adminNotifications: { ...DEFAULT_ADMIN_NOTIFICATION_SETTINGS },
    smtpSettings: { ...DEFAULT_SMTP_SETTINGS },
    facebookAutoPost: { ...DEFAULT_FACEBOOK_AUTO_POST },
    paymongoCheckoutLinks: { ...DEFAULT_PAYMONGO_CHECKOUT_LINKS },
  },
  items: [
    {
      id: "CL001",
      name: "Floral Summer Dress",
      category: "Clothes",
      price: 450,
      stock: 5,
      description: "Lightweight preloved dress in excellent condition.",
      paymongoLink: "",
      isBlocked: false,
      imageUrl:
        "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=900&q=80",
    },
    {
      id: "CL002",
      name: "Denim Jacket",
      category: "Clothes",
      price: 650,
      stock: 4,
      description: "Classic denim jacket with minimal signs of use.",
      paymongoLink: "",
      isBlocked: false,
      imageUrl:
        "https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=900&q=80",
    },
    {
      id: "BG001",
      name: "Leather Tote Bag",
      category: "Bags",
      price: 1200,
      stock: 3,
      description: "Spacious tote bag, clean interior and sturdy straps.",
      paymongoLink: "",
      isBlocked: false,
      imageUrl:
        "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=900&q=80",
    },
    {
      id: "BG002",
      name: "Canvas Crossbody Bag",
      category: "Bags",
      price: 550,
      stock: 6,
      description: "Everyday crossbody bag, easy to clean and carry.",
      paymongoLink: "",
      isBlocked: false,
      imageUrl:
        "https://images.unsplash.com/photo-1591561954557-26941169b49e?auto=format&fit=crop&w=900&q=80",
    },
    {
      id: "UT001",
      name: "Stainless Spoon and Fork Set (12pcs)",
      category: "Miscellaneous",
      price: 350,
      stock: 10,
      description: "Preloved stainless utensil set, polished and sanitized.",
      paymongoLink: "",
      isBlocked: false,
      imageUrl:
        "https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=900&q=80",
    },
    {
      id: "UT002",
      name: "Ceramic Dinner Plate Set (6pcs)",
      category: "Miscellaneous",
      price: 700,
      stock: 4,
      description: "Ceramic plate set with subtle floral print.",
      paymongoLink: "",
      isBlocked: false,
      imageUrl:
        "https://images.unsplash.com/photo-1603199506016-b9a594b593c0?auto=format&fit=crop&w=900&q=80",
    },
  ],
  users: [],
  orders: [],
};

let sqliteDb = null;

function getSqliteDatabase() {
  if (sqliteDb) {
    return sqliteDb;
  }

  sqliteDb = new DatabaseSync(sqliteFile);
  return sqliteDb;
}

function writeJsonSnapshot(store) {
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), "utf-8");
}

function readSeedStoreFromSnapshot() {
  if (!fs.existsSync(dataFile)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(dataFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (_error) {
    return null;
  }

  return null;
}

function getSupabaseConfigOrThrow() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const apiKeyCandidates = [
    serviceRoleKey,
    String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim(),
    String(process.env.SUPABASE_ANON_KEY || "").trim(),
    String(process.env.SUPABASE_KEY || "").trim(),
  ];
  const apiKey = apiKeyCandidates.find((value) => value) || "";
  const requireServiceRole = process.env.NODE_ENV === "production" && ACTIVE_STORAGE_PROVIDER === STORAGE_PROVIDERS.SUPABASE;

  if (!url || !apiKey) {
    throw new Error(
      "SUPABASE_URL and a Supabase API key are required when STORAGE_PROVIDER=SUPABASE."
    );
  }

  if (requireServiceRole && !serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required in production when STORAGE_PROVIDER=SUPABASE."
    );
  }

  return { url, apiKey };
}

function executeSupabaseRequest({ method, pathWithQuery, body, preferHeader = "" }) {
  const config = getSupabaseConfigOrThrow();
  const url = `${config.url}${pathWithQuery}`;
  const args = [
    "-sS",
    "-f",
    "-m",
    "20",
    "-X",
    String(method || "GET").toUpperCase(),
    url,
    "-H",
    `apikey: ${config.apiKey}`,
    "-H",
    `Authorization: Bearer ${config.apiKey}`,
    "-H",
    "Accept: application/json",
    "-H",
    "Content-Type: application/json",
  ];

  if (preferHeader) {
    args.push("-H", `Prefer: ${preferHeader}`);
  }

  if (body !== undefined) {
    args.push("--data", JSON.stringify(body));
  }

  try {
    return execFileSync("curl", args, { encoding: "utf-8" });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        "curl is not installed in this runtime image. Install curl or switch the Supabase adapter away from execFileSync."
      );
    }
    const output = String((error && error.stderr) || (error && error.message) || "").trim();
    throw new Error(
      output ||
        "Supabase request failed. Ensure the table exists and credentials are correct."
    );
  }
}

function readSupabaseStore() {
  const output = executeSupabaseRequest({
    method: "GET",
    pathWithQuery: "/rest/v1/app_state?id=eq.1&select=state",
  });

  const rows = JSON.parse(output || "[]");
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const state = rows[0] && rows[0].state;
  if (!state) {
    return null;
  }

  if (typeof state === "string") {
    return JSON.parse(state);
  }

  if (typeof state === "object") {
    return state;
  }

  return null;
}

function writeSupabaseStore(store) {
  const now = new Date().toISOString();
  executeSupabaseRequest({
    method: "POST",
    pathWithQuery: "/rest/v1/app_state?on_conflict=id",
    preferHeader: "resolution=merge-duplicates,return=minimal",
    body: {
      id: 1,
      state: store,
      updated_at: now,
    },
  });
}

function ensureDataFile() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (ACTIVE_STORAGE_PROVIDER === STORAGE_PROVIDERS.JSON) {
    if (!fs.existsSync(dataFile)) {
      fs.writeFileSync(dataFile, JSON.stringify(initialData, null, 2), "utf-8");
    }
    return;
  }

  if (ACTIVE_STORAGE_PROVIDER === STORAGE_PROVIDERS.SUPABASE) {
    let existingStore = null;
    try {
      existingStore = readSupabaseStore();
    } catch (error) {
      throw new Error(
        `${error.message}\nRun sql/supabase_init.sql in Supabase SQL Editor, then retry.`
      );
    }

    if (existingStore) {
      writeJsonSnapshot(existingStore);
      return;
    }

    const seedStore = readSeedStoreFromSnapshot() || initialData;
    writeSupabaseStore(seedStore);
    writeJsonSnapshot(seedStore);
    return;
  }

  const db = getSqliteDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const row = db.prepare("SELECT state FROM app_state WHERE id = 1").get();
  if (row && typeof row.state === "string" && row.state.trim()) {
    return;
  }

  const seedStore = readSeedStoreFromSnapshot() || initialData;
  db.prepare(
    "INSERT INTO app_state (id, state, updated_at) VALUES (1, ?, ?)"
  ).run(JSON.stringify(seedStore), new Date().toISOString());

  writeJsonSnapshot(seedStore);
}

function normalizeCategories(store) {
  let hasChanges = false;

  for (const item of store.items || []) {
    if (item.category === "Utensils") {
      item.category = "Miscellaneous";
      hasChanges = true;
    }
  }

  for (const order of store.orders || []) {
    for (const orderItem of order.items || []) {
      if (orderItem.category === "Utensils") {
        orderItem.category = "Miscellaneous";
        hasChanges = true;
      }
    }
  }

  return hasChanges;
}

function normalizeAdminNotificationSettings(settings) {
  return {
    ...DEFAULT_ADMIN_NOTIFICATION_SETTINGS,
    ...settings,
    enabled: settings && Object.prototype.hasOwnProperty.call(settings, "enabled")
      ? Boolean(settings.enabled)
      : DEFAULT_ADMIN_NOTIFICATION_SETTINGS.enabled,
    newOrderEmail: String((settings && settings.newOrderEmail) || "").trim().toLowerCase(),
  };
}

function normalizeNullableBoolean(value, fallback = null) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }

  return fallback;
}

function normalizeSmtpSettings(settings) {
  const normalizedPort = Number(settings && settings.port);
  const port = Number.isInteger(normalizedPort) && normalizedPort > 0 && normalizedPort <= 65535
    ? normalizedPort
    : null;

  return {
    ...DEFAULT_SMTP_SETTINGS,
    ...settings,
    host: String((settings && settings.host) || "").trim(),
    port,
    secure: normalizeNullableBoolean(settings && settings.secure, null),
    user: String((settings && settings.user) || "").trim(),
    pass: String((settings && settings.pass) || "").trim(),
    fromEmail: String((settings && settings.fromEmail) || "").trim(),
    fromName: String((settings && settings.fromName) || "").trim(),
    rejectUnauthorized: normalizeNullableBoolean(settings && settings.rejectUnauthorized, null),
  };
}

function normalizeOrders(store) {
  let hasChanges = false;

  for (const order of store.orders || []) {
    const currentStatus = String(order.status || ORDER_STATUSES.PENDING).toUpperCase();
    let normalizedStatus = currentStatus;

    if (currentStatus === "APPROVED") {
      normalizedStatus = ORDER_STATUSES.PAID;
    }

    if (!Object.prototype.hasOwnProperty.call(ORDER_STATUS_TRANSITIONS, normalizedStatus)) {
      normalizedStatus = ORDER_STATUSES.PENDING;
    }

    if (order.status !== normalizedStatus) {
      order.status = normalizedStatus;
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "paidAt")) {
      order.paidAt = order.approvedAt || null;
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "forDeliveryAt")) {
      order.forDeliveryAt = null;
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "receivedAt")) {
      order.receivedAt = null;
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "pendingReminderNotifiedAt")) {
      order.pendingReminderNotifiedAt = null;
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "isArchived")) {
      order.isArchived = false;
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "archivedAt")) {
      order.archivedAt = null;
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "deliveryRegionCode")) {
      order.deliveryRegionCode = "";
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "deliveryRegion")) {
      order.deliveryRegion = "";
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "deliveryCityCode")) {
      order.deliveryCityCode = "";
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "deliveryCity")) {
      order.deliveryCity = "";
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "deliveryBarangayCode")) {
      order.deliveryBarangayCode = "";
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "deliveryBarangay")) {
      order.deliveryBarangay = "";
      hasChanges = true;
    }

    if (!Object.prototype.hasOwnProperty.call(order, "deliveryAddressLine")) {
      order.deliveryAddressLine = "";
      hasChanges = true;
    }
  }

  return hasChanges;
}

function normalizeItems(store) {
  let hasChanges = false;

  for (const item of store.items || []) {
    const normalizedPaymongoLink = String(item.paymongoLink || "").trim();
    if (item.paymongoLink !== normalizedPaymongoLink) {
      item.paymongoLink = normalizedPaymongoLink;
      hasChanges = true;
    }

    const normalizedBlocked = Boolean(item.isBlocked);
    if (item.isBlocked !== normalizedBlocked) {
      item.isBlocked = normalizedBlocked;
      hasChanges = true;
    }
  }

  return hasChanges;
}

function normalizeStoreStructure(store) {
  let hasChanges = false;

  if (!Array.isArray(store.items)) {
    store.items = [];
    hasChanges = true;
  }

  if (!Array.isArray(store.orders)) {
    store.orders = [];
    hasChanges = true;
  }

  if (!Array.isArray(store.users)) {
    store.users = [];
    hasChanges = true;
  }

  if (!store.meta || typeof store.meta !== "object") {
    store.meta = {};
    hasChanges = true;
  }

  if (!Number.isInteger(store.meta.nextOrderId) || store.meta.nextOrderId < 1) {
    const nextOrderId =
      (store.orders || []).reduce((max, order) => Math.max(max, Number(order.id) || 0), 0) + 1;
    store.meta.nextOrderId = nextOrderId;
    hasChanges = true;
  }

  if (!Number.isInteger(store.meta.nextUserId) || store.meta.nextUserId < 1) {
    const nextUserId =
      store.users.reduce((max, user) => Math.max(max, Number(user.id) || 0), 0) + 1;
    store.meta.nextUserId = nextUserId;
    hasChanges = true;
  }

  const currentAdminNotifications = store.meta.adminNotifications;
  const normalizedAdminNotifications = normalizeAdminNotificationSettings(
    currentAdminNotifications || {}
  );
  if (
    JSON.stringify(currentAdminNotifications || null) !==
    JSON.stringify(normalizedAdminNotifications)
  ) {
    store.meta.adminNotifications = normalizedAdminNotifications;
    hasChanges = true;
  }

  const currentSmtpSettings = store.meta.smtpSettings;
  const normalizedSmtpSettings = normalizeSmtpSettings(currentSmtpSettings || {});
  if (JSON.stringify(currentSmtpSettings || null) !== JSON.stringify(normalizedSmtpSettings)) {
    store.meta.smtpSettings = normalizedSmtpSettings;
    hasChanges = true;
  }

  const currentFacebookConfig = store.meta.facebookAutoPost;
  const normalizedFacebookConfig = normalizeFacebookAutoPostConfig(currentFacebookConfig || {});
  if (JSON.stringify(currentFacebookConfig || null) !== JSON.stringify(normalizedFacebookConfig)) {
    store.meta.facebookAutoPost = normalizedFacebookConfig;
    hasChanges = true;
  }

  const currentPaymongoCheckoutLinks = store.meta.paymongoCheckoutLinks;
  const normalizedPaymongoCheckoutLinks = normalizePaymongoCheckoutLinks(
    currentPaymongoCheckoutLinks || {}
  );
  if (
    JSON.stringify(currentPaymongoCheckoutLinks || null) !==
    JSON.stringify(normalizedPaymongoCheckoutLinks)
  ) {
    store.meta.paymongoCheckoutLinks = normalizedPaymongoCheckoutLinks;
    hasChanges = true;
  }

  return hasChanges;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  if (parsed < min) {
    return min;
  }

  if (parsed > max) {
    return max;
  }

  return parsed;
}

function normalizeFacebookAutoPostConfig(config) {
  const availablePages = Array.isArray(config && config.availablePages)
    ? config.availablePages
        .map((page) => ({
          id: String((page && page.id) || "").trim(),
          name: String((page && page.name) || "").trim(),
          accessToken: String((page && (page.accessToken || page.access_token)) || "").trim(),
          category: String((page && page.category) || "").trim(),
        }))
        .filter((page) => page.id && page.name)
    : [];

  return {
    ...DEFAULT_FACEBOOK_AUTO_POST,
    ...config,
    enabled: Boolean(config && config.enabled),
    appId: String((config && config.appId) || "").trim(),
    appSecret: String((config && config.appSecret) || "").trim(),
    loginRedirectUri: String((config && config.loginRedirectUri) || "").trim(),
    userAccessToken: String((config && config.userAccessToken) || "").trim(),
    selectedPageId: String((config && config.selectedPageId) || "").trim(),
    availablePages,
    pageId: String((config && config.pageId) || "").trim(),
    pageName: String((config && config.pageName) || "").trim(),
    pageAccessToken: String((config && config.pageAccessToken) || "").trim(),
    baseUrl: String((config && config.baseUrl) || DEFAULT_FACEBOOK_AUTO_POST.baseUrl).trim(),
    timezone: String((config && config.timezone) || DEFAULT_FACEBOOK_AUTO_POST.timezone).trim(),
    hour: clampInteger(
      config && config.hour,
      0,
      23,
      DEFAULT_FACEBOOK_AUTO_POST.hour
    ),
    minute: clampInteger(
      config && config.minute,
      0,
      59,
      DEFAULT_FACEBOOK_AUTO_POST.minute
    ),
    itemsPerPost: clampInteger(
      config && config.itemsPerPost,
      1,
      6,
      DEFAULT_FACEBOOK_AUTO_POST.itemsPerPost
    ),
    lastPostStatus: String((config && config.lastPostStatus) || DEFAULT_FACEBOOK_AUTO_POST.lastPostStatus),
    lastPostMessage: String((config && config.lastPostMessage) || ""),
    lastPostId: String((config && config.lastPostId) || ""),
    lastPostedAt: (config && config.lastPostedAt) || null,
    lastAttemptAt: (config && config.lastAttemptAt) || null,
    lastTriggeredBy: String((config && config.lastTriggeredBy) || ""),
  };
}

function normalizePaymongoCheckoutLinks(config) {
  const step = DEFAULT_PAYMONGO_CHECKOUT_LINKS.step;
  const source =
    config && typeof config === "object" && !Array.isArray(config)
      ? config
      : {};
  const rawLinks =
    source.links && typeof source.links === "object" && !Array.isArray(source.links)
      ? source.links
      : source;

  const links = {};
  for (const [amountKey, urlValue] of Object.entries(rawLinks || {})) {
    const amount = Number(amountKey);
    const url = String(urlValue || "").trim();
    if (!Number.isInteger(amount) || amount < step || amount % step !== 0 || !url) {
      continue;
    }
    links[String(amount)] = url;
  }

  return {
    step,
    links,
  };
}

function normalizeDeliveryArea(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toUpperCase();
}

function inferDeliveryAreaFromAddress(address) {
  const normalized = String(address || "").toLowerCase();

  if (normalized.includes("metro manila") || normalized.includes("ncr") || normalized.includes("manila")) {
    return "MANILA";
  }

  if (normalized.includes("mindanao")) {
    return "MINDANAO";
  }

  if (normalized.includes("visayas")) {
    return "VISAYAS";
  }

  if (normalized.includes("luzon")) {
    return "LUZON";
  }

  return "";
}

function inferDeliveryAreaFromRegion(regionCode, regionName) {
  const normalizedCode = String(regionCode || "").trim();
  const normalizedName = String(regionName || "").toLowerCase();

  if (normalizedCode === "1300000000") {
    return "MANILA";
  }

  const regionNumber = Number(normalizedCode.slice(0, 2));
  if ([1, 2, 3, 4, 5, 13, 14, 17].includes(regionNumber)) {
    return "LUZON";
  }

  if ([6, 7, 8, 18].includes(regionNumber)) {
    return "VISAYAS";
  }

  if ([9, 10, 11, 12, 15, 16, 19].includes(regionNumber)) {
    return "MINDANAO";
  }

  if (normalizedName.includes("manila") || normalizedName.includes("ncr")) {
    return "MANILA";
  }

  if (normalizedName.includes("visayas")) {
    return "VISAYAS";
  }

  if (normalizedName.includes("mindanao")) {
    return "MINDANAO";
  }

  if (normalizedName.includes("luzon")) {
    return "LUZON";
  }

  return "";
}

function getDeliveryFeeByArea(area) {
  const normalized = normalizeDeliveryArea(area);
  const fee = DELIVERY_FEES[normalized];
  return Number.isFinite(fee) ? fee : null;
}

function readStore() {
  ensureDataFile();
  let store;

  if (ACTIVE_STORAGE_PROVIDER === STORAGE_PROVIDERS.JSON) {
    const raw = fs.readFileSync(dataFile, "utf-8");
    store = JSON.parse(raw);
  } else if (ACTIVE_STORAGE_PROVIDER === STORAGE_PROVIDERS.SUPABASE) {
    store = readSupabaseStore();
    if (!store) {
      throw new Error("Database state was not found in Supabase.");
    }
  } else {
    const db = getSqliteDatabase();
    const row = db.prepare("SELECT state FROM app_state WHERE id = 1").get();
    if (!row || typeof row.state !== "string") {
      throw new Error("Database state was not found.");
    }
    store = JSON.parse(row.state);
  }

  let hasChanges = false;

  hasChanges = normalizeStoreStructure(store) || hasChanges;
  hasChanges = normalizeItems(store) || hasChanges;
  hasChanges = normalizeCategories(store) || hasChanges;
  hasChanges = normalizeOrders(store) || hasChanges;

  if (hasChanges) {
    writeStore(store);
  }

  return store;
}

function writeStore(store) {
  if (ACTIVE_STORAGE_PROVIDER === STORAGE_PROVIDERS.JSON) {
    writeJsonSnapshot(store);
    return;
  }

  if (ACTIVE_STORAGE_PROVIDER === STORAGE_PROVIDERS.SUPABASE) {
    writeSupabaseStore(store);
    writeJsonSnapshot(store);
    return;
  }

  const db = getSqliteDatabase();
  const serialized = JSON.stringify(store);
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id FROM app_state WHERE id = 1").get();

  if (existing) {
    db.prepare("UPDATE app_state SET state = ?, updated_at = ? WHERE id = 1").run(serialized, now);
  } else {
    db.prepare("INSERT INTO app_state (id, state, updated_at) VALUES (1, ?, ?)").run(serialized, now);
  }

  writeJsonSnapshot(store);
}

function getItems() {
  const store = readStore();
  return store.items;
}

function normalizeItemCategory(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "CLOTHES" || normalized === "CLOTHING") {
    return ITEM_CATEGORIES.CLOTHES;
  }
  if (normalized === "BAGS" || normalized === "BAG") {
    return ITEM_CATEGORIES.BAGS;
  }
  if (
    normalized === "MISCELLANEOUS" ||
    normalized === "MISC" ||
    normalized === "UTENSILS" ||
    normalized === "MISCELLANEOUS ITEMS"
  ) {
    return ITEM_CATEGORIES.MISCELLANEOUS;
  }
  throw new Error("Category must be Clothes, Bags, or Miscellaneous.");
}

function normalizeItemName(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Item name is required.");
  }
  if (normalized.length > 120) {
    throw new Error("Item name is too long.");
  }
  return normalized;
}

function normalizeItemDescription(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Description is required.");
  }
  if (normalized.length > 500) {
    throw new Error("Description is too long.");
  }
  return normalized;
}

function normalizeItemPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("Price must be a valid number.");
  }
  return Number(numeric.toFixed(2));
}

function normalizeItemStock(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error("Stock must be a whole number (0 or higher).");
  }
  return numeric;
}

function normalizeItemImageUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("Image URL is required.");
  }
  return normalized;
}

function getItemPrefixByCategory(category) {
  if (category === ITEM_CATEGORIES.CLOTHES) {
    return "CL";
  }
  if (category === ITEM_CATEGORIES.BAGS) {
    return "BG";
  }
  return "MS";
}

function generateNextItemId(store, category) {
  const prefix = getItemPrefixByCategory(category);
  const highest = (store.items || [])
    .filter((item) => String(item.id || "").startsWith(prefix))
    .map((item) => Number(String(item.id || "").slice(prefix.length)))
    .filter((value) => Number.isInteger(value))
    .reduce((max, current) => Math.max(max, current), 0);

  const next = highest + 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

function createItem(payload) {
  const store = readStore();
  const category = normalizeItemCategory(payload.category);
  const item = {
    id: generateNextItemId(store, category),
    name: normalizeItemName(payload.name),
    category,
    price: normalizeItemPrice(payload.price),
    stock: normalizeItemStock(payload.stock),
    description: normalizeItemDescription(payload.description),
    paymongoLink: String(payload.paymongoLink || "").trim(),
    isBlocked: false,
    imageUrl: normalizeItemImageUrl(payload.imageUrl),
  };

  store.items.push(item);
  writeStore(store);
  return item;
}

function updateItemInventory(itemId, payload) {
  const store = readStore();
  const item = store.items.find((entry) => entry.id === String(itemId || ""));

  if (!item) {
    throw new Error("Item not found.");
  }

  item.name = normalizeItemName(payload.name);
  item.category = normalizeItemCategory(payload.category);
  item.price = normalizeItemPrice(payload.price);
  item.stock = normalizeItemStock(payload.stock);
  item.description = normalizeItemDescription(payload.description);
  item.imageUrl = normalizeItemImageUrl(payload.imageUrl);
  writeStore(store);
  return item;
}

function setItemBlocked(itemId, blocked) {
  const store = readStore();
  const item = store.items.find((entry) => entry.id === String(itemId || ""));

  if (!item) {
    throw new Error("Item not found.");
  }

  item.isBlocked = Boolean(blocked);
  writeStore(store);
  return item;
}

function updateItemPaymongoLink(itemId, paymongoLink) {
  const store = readStore();
  const item = store.items.find((entry) => entry.id === String(itemId || ""));

  if (!item) {
    throw new Error("Item not found.");
  }

  item.paymongoLink = String(paymongoLink || "").trim();
  writeStore(store);
  return item;
}

function updateItemName(itemId, name) {
  const store = readStore();
  const item = store.items.find((entry) => entry.id === String(itemId || ""));

  if (!item) {
    throw new Error("Item not found.");
  }

  const normalizedName = String(name || "").trim().replace(/\s+/g, " ");
  if (!normalizedName) {
    throw new Error("Product name is required.");
  }

  if (normalizedName.length > 120) {
    throw new Error("Product name is too long.");
  }

  item.name = normalizedName;
  writeStore(store);
  return item;
}

function getOrders() {
  const store = readStore();
  return [...store.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getOrderById(orderId) {
  const store = readStore();
  return store.orders.find((entry) => entry.id === Number(orderId)) || null;
}

function getAdminNotificationSettings() {
  const store = readStore();
  return normalizeAdminNotificationSettings(store.meta.adminNotifications);
}

function saveAdminNotificationSettings(nextSettings) {
  const store = readStore();
  const normalized = normalizeAdminNotificationSettings(nextSettings);
  store.meta.adminNotifications = normalized;
  writeStore(store);
  return normalized;
}

function getFacebookAutoPostConfig() {
  const store = readStore();
  return normalizeFacebookAutoPostConfig(store.meta.facebookAutoPost);
}

function getSmtpSettings() {
  const store = readStore();
  return normalizeSmtpSettings(store.meta.smtpSettings);
}

function saveSmtpSettings(nextSettings) {
  const store = readStore();
  const normalized = normalizeSmtpSettings(nextSettings);
  store.meta.smtpSettings = normalized;
  writeStore(store);
  return normalized;
}

function saveFacebookAutoPostConfig(nextConfig) {
  const store = readStore();
  const normalized = normalizeFacebookAutoPostConfig(nextConfig);
  store.meta.facebookAutoPost = normalized;
  writeStore(store);
  return normalized;
}

function setFacebookAutoPostLastResult(payload) {
  const store = readStore();
  const current = normalizeFacebookAutoPostConfig(store.meta.facebookAutoPost);

  current.lastPostStatus = String(payload.status || current.lastPostStatus || "IDLE").toUpperCase();
  current.lastPostMessage = String(payload.message || "");
  current.lastPostId = String(payload.postId || "");
  current.lastTriggeredBy = String(payload.triggeredBy || "");
  current.lastAttemptAt = payload.attemptedAt || new Date().toISOString();

  if (current.lastPostStatus === "SUCCESS") {
    current.lastPostedAt = payload.postedAt || new Date().toISOString();
  }

  store.meta.facebookAutoPost = current;
  writeStore(store);
  return current;
}

function getPaymongoCheckoutLinks() {
  const store = readStore();
  return normalizePaymongoCheckoutLinks(store.meta.paymongoCheckoutLinks);
}

function savePaymongoAmountLink(amount, link) {
  const step = DEFAULT_PAYMONGO_CHECKOUT_LINKS.step;
  const numericAmount = Number(amount);
  if (!Number.isInteger(numericAmount) || numericAmount < step || numericAmount % step !== 0) {
    throw new Error(`Amount must be a multiple of ${step}.`);
  }

  const normalizedLink = String(link || "").trim();
  if (!normalizedLink) {
    throw new Error("PayMongo link is required.");
  }

  const store = readStore();
  const current = normalizePaymongoCheckoutLinks(store.meta.paymongoCheckoutLinks);
  current.links[String(numericAmount)] = normalizedLink;
  store.meta.paymongoCheckoutLinks = current;
  writeStore(store);
  return current;
}

function deletePaymongoAmountLink(amount) {
  const step = DEFAULT_PAYMONGO_CHECKOUT_LINKS.step;
  const numericAmount = Number(amount);
  if (!Number.isInteger(numericAmount) || numericAmount < step || numericAmount % step !== 0) {
    throw new Error(`Amount must be a multiple of ${step}.`);
  }

  const store = readStore();
  const current = normalizePaymongoCheckoutLinks(store.meta.paymongoCheckoutLinks);
  delete current.links[String(numericAmount)];
  store.meta.paymongoCheckoutLinks = current;
  writeStore(store);
  return current;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function toBuyerPublic(user) {
  if (!user) {
    return null;
  }

  return {
    id: Number(user.id),
    email: String(user.email || "").trim().toLowerCase(),
    fullName: String(user.fullName || "").trim(),
    phone: String(user.phone || "").trim(),
    createdAt: user.createdAt || null,
  };
}

function getBuyerByEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const store = readStore();
  return store.users.find((user) => String(user.email || "").toLowerCase() === normalizedEmail) || null;
}

function getBuyerPublicById(userId) {
  const numericId = Number(userId);
  if (!Number.isInteger(numericId) || numericId < 1) {
    return null;
  }

  const store = readStore();
  const user = store.users.find((entry) => Number(entry.id) === numericId);
  return toBuyerPublic(user);
}

function verifyPassword(user, password) {
  if (!user || !user.passwordSalt || !user.passwordHash) {
    return false;
  }

  const input = String(password || "");
  if (!input) {
    return false;
  }

  try {
    const expected = Buffer.from(String(user.passwordHash), "hex");
    const actual = crypto.scryptSync(input, String(user.passwordSalt), 64);

    if (expected.length !== actual.length) {
      return false;
    }

    return crypto.timingSafeEqual(expected, actual);
  } catch (_error) {
    return false;
  }
}

function authenticateBuyerAccount(email, password) {
  const user = getBuyerByEmail(email);
  if (!user) {
    return null;
  }

  if (!verifyPassword(user, password)) {
    return null;
  }

  return toBuyerPublic(user);
}

function createBuyerAccount(payload) {
  const store = readStore();
  const email = String(payload.email || "").trim().toLowerCase();

  if (!email) {
    throw new Error("Account email is required.");
  }

  const existing = store.users.find((user) => String(user.email || "").toLowerCase() === email);
  if (existing) {
    throw new Error("An account with this email already exists. Choose guest checkout or use another email.");
  }

  const password = String(payload.password || "");
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: store.meta.nextUserId,
    email,
    fullName: String(payload.fullName || "").trim(),
    phone: String(payload.phone || "").trim(),
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
  };

  store.meta.nextUserId += 1;
  store.users.push(user);
  writeStore(store);
  return toBuyerPublic(user);
}

function createOrder(payload) {
  const store = readStore();

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("Cart is empty.");
  }

  const orderItems = payload.items.map((requestedItem) => {
    const product = store.items.find((item) => item.id === requestedItem.itemId);

    if (!product) {
      throw new Error(`Item ${requestedItem.itemId} not found.`);
    }

    if (product.isBlocked) {
      throw new Error(`${product.name} is currently unavailable.`);
    }

    if (!Number.isInteger(requestedItem.quantity) || requestedItem.quantity < 1) {
      throw new Error(`Invalid quantity for ${product.name}.`);
    }

    return {
      itemId: product.id,
      name: product.name,
      category: product.category,
      quantity: requestedItem.quantity,
      unitPrice: product.price,
      subtotal: product.price * requestedItem.quantity,
    };
  });

  const itemSubtotal = orderItems.reduce((sum, current) => sum + current.subtotal, 0);
  const deliveryRegionCode = String(payload.deliveryRegionCode || "").trim();
  const deliveryRegion = String(payload.deliveryRegion || "").trim();
  const deliveryCityCode = String(payload.deliveryCityCode || "").trim();
  const deliveryCity = String(payload.deliveryCity || "").trim();
  const deliveryBarangayCode = String(payload.deliveryBarangayCode || "").trim();
  const deliveryBarangay = String(payload.deliveryBarangay || "").trim();
  const deliveryAddressLine = String(payload.deliveryAddressLine || "").trim();
  const deliveryAddress = String(payload.deliveryAddress || "").trim() || [
    deliveryAddressLine,
    deliveryBarangay,
    deliveryCity,
    deliveryRegion,
  ]
    .filter(Boolean)
    .join(", ");

  const deliveryArea = normalizeDeliveryArea(
    payload.deliveryArea ||
      inferDeliveryAreaFromRegion(deliveryRegionCode, deliveryRegion) ||
      inferDeliveryAreaFromAddress(deliveryAddress)
  );
  const deliveryFee = getDeliveryFeeByArea(deliveryArea);

  if (deliveryFee === null) {
    throw new Error("Unable to compute delivery fee from selected region. Please choose a valid location.");
  }

  const grandTotal = itemSubtotal + deliveryFee;

  const order = {
    id: store.meta.nextOrderId,
    buyerName: payload.buyerName,
    buyerEmail: payload.buyerEmail,
    buyerPhone: payload.buyerPhone,
    deliveryRegionCode,
    deliveryRegion,
    deliveryCityCode,
    deliveryCity,
    deliveryBarangayCode,
    deliveryBarangay,
    deliveryAddressLine,
    deliveryAddress,
    deliveryArea,
    deliveryFee,
    gcashNumber: payload.gcashNumber,
    gcashReference: payload.gcashReference,
    paymentProofPath: payload.paymentProofPath,
    checkoutMode: payload.checkoutMode || CHECKOUT_MODES.GUEST,
    buyerAccountId: Number.isInteger(payload.buyerAccountId) ? payload.buyerAccountId : null,
    status: ORDER_STATUSES.PENDING,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paidAt: null,
    forDeliveryAt: null,
    receivedAt: null,
    emailNotifiedAt: null,
    pendingReminderNotifiedAt: null,
    isArchived: false,
    archivedAt: null,
    items: orderItems,
    itemSubtotal,
    grandTotal,
    totalAmount: grandTotal,
  };

  store.meta.nextOrderId += 1;
  store.orders.push(order);
  writeStore(store);

  return order;
}

function approveOrder(orderId) {
  return updateOrderStatus(orderId, ORDER_STATUSES.PAID);
}

function updateOrderStatus(orderId, nextStatus) {
  const store = readStore();
  const order = store.orders.find((entry) => entry.id === Number(orderId));

  if (!order) {
    throw new Error("Order not found.");
  }

  if (order.isArchived) {
    throw new Error("Archived orders cannot be updated. Unarchive first.");
  }

  const targetStatus = String(nextStatus || "").toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(ORDER_STATUS_TRANSITIONS, targetStatus)) {
    throw new Error("Invalid order status.");
  }

  const currentStatus = String(order.status || ORDER_STATUSES.PENDING).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(ORDER_STATUS_TRANSITIONS, currentStatus)) {
    order.status = ORDER_STATUSES.PENDING;
  }

  if (currentStatus === targetStatus) {
    throw new Error(`Order is already marked as ${targetStatus}.`);
  }

  const allowedTransitions = ORDER_STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowedTransitions.includes(targetStatus)) {
    throw new Error(`Cannot change status from ${currentStatus} to ${targetStatus}.`);
  }

  if (currentStatus === ORDER_STATUSES.PENDING && targetStatus === ORDER_STATUSES.PAID) {
    for (const requestedItem of order.items) {
      const product = store.items.find((item) => item.id === requestedItem.itemId);

      if (!product) {
        throw new Error(`Item ${requestedItem.itemId} no longer exists.`);
      }

      if (product.stock < requestedItem.quantity) {
        throw new Error(`Not enough stock for ${product.name}.`);
      }
    }

    for (const requestedItem of order.items) {
      const product = store.items.find((item) => item.id === requestedItem.itemId);
      product.stock -= requestedItem.quantity;
    }
  }

  const now = new Date().toISOString();
  order.status = targetStatus;

  if (targetStatus === ORDER_STATUSES.PAID) {
    order.paidAt = now;
    order.approvedAt = now;
  }

  if (targetStatus === ORDER_STATUSES.FOR_DELIVERY) {
    order.forDeliveryAt = now;
  }

  if (targetStatus === ORDER_STATUSES.RECEIVED) {
    order.receivedAt = now;
  }

  writeStore(store);
  return order;
}

function archiveOrder(orderId) {
  const store = readStore();
  const order = store.orders.find((entry) => entry.id === Number(orderId));

  if (!order) {
    throw new Error("Order not found.");
  }

  if (order.isArchived) {
    throw new Error("Order is already archived.");
  }

  order.isArchived = true;
  order.archivedAt = new Date().toISOString();
  writeStore(store);
  return order;
}

function unarchiveOrder(orderId) {
  const store = readStore();
  const order = store.orders.find((entry) => entry.id === Number(orderId));

  if (!order) {
    throw new Error("Order not found.");
  }

  if (!order.isArchived) {
    throw new Error("Order is not archived.");
  }

  order.isArchived = false;
  order.archivedAt = null;
  writeStore(store);
  return order;
}

function deleteOrder(orderId) {
  const store = readStore();
  const index = store.orders.findIndex((entry) => entry.id === Number(orderId));

  if (index === -1) {
    throw new Error("Order not found.");
  }

  const order = store.orders[index];
  if (!order.isArchived) {
    throw new Error("Archive the order first before deleting.");
  }

  const normalizedStatus = String(order.status || "").toUpperCase();
  const shouldRestoreStock =
    normalizedStatus === ORDER_STATUSES.PAID || normalizedStatus === ORDER_STATUSES.FOR_DELIVERY;

  if (shouldRestoreStock) {
    for (const requestedItem of order.items || []) {
      const product = store.items.find((item) => item.id === requestedItem.itemId);
      if (product) {
        product.stock += Number(requestedItem.quantity) || 0;
      }
    }
  }

  store.orders.splice(index, 1);
  writeStore(store);
  return order;
}

function markOrderEmailNotified(orderId) {
  const store = readStore();
  const order = store.orders.find((entry) => entry.id === Number(orderId));

  if (!order) {
    return;
  }

  order.emailNotifiedAt = new Date().toISOString();
  writeStore(store);
}

function markOrderPendingReminderNotified(orderId) {
  const store = readStore();
  const order = store.orders.find((entry) => entry.id === Number(orderId));

  if (!order) {
    return;
  }

  order.pendingReminderNotifiedAt = new Date().toISOString();
  writeStore(store);
}

module.exports = {
  STORAGE_PROVIDERS,
  ACTIVE_STORAGE_PROVIDER,
  DELIVERY_FEES,
  CHECKOUT_MODES,
  ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  DEFAULT_ADMIN_NOTIFICATION_SETTINGS,
  DEFAULT_SMTP_SETTINGS,
  DEFAULT_FACEBOOK_AUTO_POST,
  DEFAULT_PAYMONGO_CHECKOUT_LINKS,
  ITEM_CATEGORIES,
  ensureDataFile,
  getItems,
  createItem,
  updateItemInventory,
  setItemBlocked,
  updateItemPaymongoLink,
  updateItemName,
  getOrders,
  getOrderById,
  getAdminNotificationSettings,
  saveAdminNotificationSettings,
  normalizeAdminNotificationSettings,
  getSmtpSettings,
  saveSmtpSettings,
  normalizeSmtpSettings,
  authenticateBuyerAccount,
  getBuyerPublicById,
  getFacebookAutoPostConfig,
  saveFacebookAutoPostConfig,
  setFacebookAutoPostLastResult,
  normalizePaymongoCheckoutLinks,
  getPaymongoCheckoutLinks,
  savePaymongoAmountLink,
  deletePaymongoAmountLink,
  createBuyerAccount,
  createOrder,
  approveOrder,
  updateOrderStatus,
  archiveOrder,
  unarchiveOrder,
  deleteOrder,
  markOrderEmailNotified,
  markOrderPendingReminderNotified,
  normalizeDeliveryArea,
  inferDeliveryAreaFromRegion,
  inferDeliveryAreaFromAddress,
  getDeliveryFeeByArea,
};
