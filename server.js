require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");

const {
  ACTIVE_STORAGE_PROVIDER,
  DELIVERY_FEES,
  CHECKOUT_MODES,
  ORDER_STATUSES,
  DEFAULT_FACEBOOK_AUTO_POST,
  ITEM_CATEGORIES,
  ensureDataFile,
  getStores,
  getStoreById,
  getStoreBySlug,
  createStore,
  getItems,
  createItem,
  updateItemInventory,
  setItemBlocked,
  getOrders,
  getAdminNotificationSettings,
  saveAdminNotificationSettings,
  getSmtpSettings,
  saveSmtpSettings,
  getFacebookAutoPostConfig,
  saveFacebookAutoPostConfig,
  setFacebookAutoPostLastResult,
  getPaymongoCheckoutLinks,
  savePaymongoAmountLink,
  deletePaymongoAmountLink,
  authenticateBuyerAccount,
  getBuyerPublicById,
  createBuyerAccount,
  authenticateStoreManager,
  getStoreManagerPublicById,
  createStoreManager,
  createOrder,
  updateItemPaymongoLink,
  updateItemName,
  approveOrder,
  updateOrderStatus,
  archiveOrder,
  unarchiveOrder,
  deleteOrder,
  markOrderEmailNotified,
  markOrderPendingReminderNotified,
} = require("./db");
const {
  formatOrderStatus,
  getSmtpConfigStatus,
  verifySmtpConnection,
  sendSmtpTestEmail,
  sendPendingOrderEmail,
  sendApprovedOrderEmail,
  sendOrderStatusUpdateEmail,
  sendNewOrderAdminEmail,
  sendUnprocessedOrderReminderEmail,
} = require("./utils/mailer");
const { fetchFacebookPages, postRandomItemsToFacebook } = require("./utils/facebookPoster");

const app = express();
const port = Number(process.env.PORT) || 3000;
const host = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const publicHostLabel = host === "0.0.0.0" ? "localhost" : host;
const UPLOAD_STORAGE_PROVIDERS = Object.freeze({
  LOCAL: "LOCAL",
  SUPABASE: "SUPABASE",
});
const IMAGE_PROCESS_MODES = Object.freeze({
  ORIGINAL: "ORIGINAL",
  CLEAN_WHITE: "CLEAN_WHITE",
  REMOVE_BACKGROUND: "REMOVE_BACKGROUND",
});
const requestedUploadStorageProvider = String(
  process.env.UPLOAD_STORAGE_PROVIDER || (ACTIVE_STORAGE_PROVIDER === "SUPABASE" ? "SUPABASE" : "LOCAL")
)
  .trim()
  .toUpperCase();
const ACTIVE_UPLOAD_STORAGE_PROVIDER = Object.values(UPLOAD_STORAGE_PROVIDERS).includes(requestedUploadStorageProvider)
  ? requestedUploadStorageProvider
  : UPLOAD_STORAGE_PROVIDERS.LOCAL;
const UNPROCESSED_ORDER_REMINDER_HOURS = Number(process.env.UNPROCESSED_ORDER_REMINDER_HOURS) > 0
  ? Number(process.env.UNPROCESSED_ORDER_REMINDER_HOURS)
  : 24;

const uploadsDir = path.join(__dirname, "public", "uploads");

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function ensureLocalUploadsDir(subdirectory = "") {
  const targetDir = path.join(uploadsDir, subdirectory);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return targetDir;
}

function getSupabaseApiConfigOrThrow() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const apiKey = [
    serviceRoleKey,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.SUPABASE_KEY,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  const requireServiceRole = process.env.NODE_ENV === "production" &&
    ACTIVE_UPLOAD_STORAGE_PROVIDER === UPLOAD_STORAGE_PROVIDERS.SUPABASE;

  if (!url || !apiKey) {
    throw new Error("Supabase URL and API key are required for persistent storage.");
  }

  if (requireServiceRole && !serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required in production when uploads use Supabase.");
  }

  return { url, apiKey };
}

function getSupabaseStorageConfigOrThrow() {
  const { url, apiKey } = getSupabaseApiConfigOrThrow();
  const bucket = String(process.env.SUPABASE_STORAGE_BUCKET || "").trim();

  if (!bucket) {
    throw new Error("SUPABASE_STORAGE_BUCKET is required for persistent file uploads.");
  }

  return { url, apiKey, bucket };
}

function ensurePersistentStorageConfig() {
  const requirePersistentStorage = process.env.NODE_ENV === "production" &&
    !isTruthyEnv(process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION);

  if (!requirePersistentStorage) {
    return;
  }

  if (ACTIVE_STORAGE_PROVIDER !== "SUPABASE") {
    throw new Error(
      "Production requires STORAGE_PROVIDER=SUPABASE. Local SQLite storage will be overwritten on redeploy."
    );
  }

  if (ACTIVE_UPLOAD_STORAGE_PROVIDER !== "SUPABASE") {
    throw new Error(
      "Production requires UPLOAD_STORAGE_PROVIDER=SUPABASE so uploaded files persist across redeploys."
    );
  }

  getSupabaseStorageConfigOrThrow();
}

function buildStoredUploadName(file) {
  const extension = path.extname(String((file && file.originalname) || "")).toLowerCase() || ".bin";
  const safeExtension = extension.replace(/[^a-z0-9.]/gi, "") || ".bin";
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExtension}`;
}

function buildSupabasePublicObjectUrl(baseUrl, bucket, objectPath) {
  const encodedPath = objectPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
}

async function storeUploadedFile({ file, folder }) {
  if (!file || !file.buffer) {
    throw new Error("Uploaded file buffer is missing.");
  }

  const safeFolder = String(folder || "general").trim().replace(/[^a-z0-9/_-]/gi, "") || "general";
  const filename = buildStoredUploadName(file);
  const objectPath = `${safeFolder}/${filename}`;

  if (ACTIVE_UPLOAD_STORAGE_PROVIDER === UPLOAD_STORAGE_PROVIDERS.SUPABASE) {
    const { url, apiKey, bucket } = getSupabaseStorageConfigOrThrow();
    const response = await fetch(
      `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`,
      {
        method: "POST",
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": String(file.mimetype || "application/octet-stream"),
          "x-upsert": "true",
        },
        body: file.buffer,
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Supabase upload failed (${response.status}): ${String(errorText || "").slice(0, 180)}`);
    }

    return buildSupabasePublicObjectUrl(url, bucket, objectPath);
  }

  const targetDir = ensureLocalUploadsDir(safeFolder);
  const localPath = path.join(targetDir, filename);
  fs.writeFileSync(localPath, file.buffer);
  return `/uploads/${objectPath}`;
}

ensurePersistentStorageConfig();
ensureDataFile();

if (ACTIVE_UPLOAD_STORAGE_PROVIDER === UPLOAD_STORAGE_PROVIDERS.LOCAL) {
  ensureLocalUploadsDir();
}

console.log(
  `[storage] db=${ACTIVE_STORAGE_PROVIDER} uploads=${ACTIVE_UPLOAD_STORAGE_PROVIDER} ` +
    `allowLocalInProduction=${isTruthyEnv(process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION)} ` +
    `supabaseUrl=${process.env.SUPABASE_URL ? "set" : "missing"} ` +
    `serviceRole=${process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing"} ` +
    `uploadBucket=${process.env.SUPABASE_STORAGE_BUCKET ? "set" : "missing"}`
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "replace-me-in-env",
    resave: false,
    saveUninitialized: false,
  })
);

app.use((req, res, next) => {
  const buyerUserId = Number(req.session && req.session.buyerUserId);
  if (!Number.isInteger(buyerUserId) || buyerUserId < 1) {
    res.locals.buyerUser = null;
    next();
    return;
  }

  const buyerUser = getBuyerPublicById(buyerUserId);
  if (!buyerUser) {
    delete req.session.buyerUserId;
    res.locals.buyerUser = null;
    next();
    return;
  }

  res.locals.buyerUser = buyerUser;
  next();
});

app.use((req, res, next) => {
  const managerUserId = Number(req.session && req.session.storeManagerUserId);
  if (!Number.isInteger(managerUserId) || managerUserId < 1) {
    res.locals.storeManagerUser = null;
    next();
    return;
  }

  const managerUser = getStoreManagerPublicById(managerUserId);
  if (!managerUser) {
    delete req.session.storeManagerUserId;
    res.locals.storeManagerUser = null;
    next();
    return;
  }

  res.locals.storeManagerUser = managerUser;
  next();
});

app.use((req, res, next) => {
  Object.assign(res.locals, getStoreRenderContext(getPlatformDefaultStore()));
  next();
});

app.locals.formatCurrency = (value) => `PHP ${Number(value).toFixed(2)}`;
app.locals.formatDate = (value) =>
  new Date(value).toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
app.locals.formatDeliveryArea = (value) => {
  const labels = {
    MANILA: "Manila",
    LUZON: "Luzon",
    VISAYAS: "Visayas",
    MINDANAO: "Mindanao",
  };

  return labels[String(value || "").toUpperCase()] || value || "-";
};

function getAdminCredentials() {
  return {
    email: process.env.ADMIN_EMAIL || "admin@prelovedbylhota.com",
    password: process.env.ADMIN_PASSWORD || "LhotaAdmin2026!",
  };
}

function getPlatformDefaultStore() {
  return getStores()[0] || null;
}

function buildStoreBasePath(store) {
  if (!store || !store.slug) {
    return "";
  }
  return `/stores/${encodeURIComponent(store.slug)}`;
}

function buildStoreCartKey(store) {
  if (!store || !store.slug) {
    return "preloved_cart";
  }
  return `preloved_cart_${String(store.slug)}`;
}

function getStoreRenderContext(store) {
  const activeStore = store || getPlatformDefaultStore();
  return {
    activeStore,
    storeName: activeStore ? activeStore.name : "Pre-loved by Lhota",
    storeBasePath: activeStore ? buildStoreBasePath(activeStore) : "",
    storeCartKey: activeStore ? buildStoreCartKey(activeStore) : "preloved_cart",
  };
}

function getCurrentStoreManager(req) {
  const managerUserId = Number(req.session && req.session.storeManagerUserId);
  if (!Number.isInteger(managerUserId) || managerUserId < 1) {
    return null;
  }
  return getStoreManagerPublicById(managerUserId);
}

function getOperatorStoreId(req) {
  const managerUser = getCurrentStoreManager(req);
  if (managerUser) {
    return Number(managerUser.storeId);
  }

  const requestedStoreId = Number(req.body && req.body.storeId ? req.body.storeId : req.query && req.query.storeId ? req.query.storeId : req.session && req.session.activeAdminStoreId);
  if (Number.isInteger(requestedStoreId) && requestedStoreId > 0) {
    if (req.session) {
      req.session.activeAdminStoreId = requestedStoreId;
    }
    return requestedStoreId;
  }

  const defaultStore = getPlatformDefaultStore();
  if (defaultStore && req.session) {
    req.session.activeAdminStoreId = defaultStore.id;
  }
  return defaultStore ? Number(defaultStore.id) : 1;
}

function resolvesToStoreManager(req) {
  return Boolean(getCurrentStoreManager(req));
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    next();
    return;
  }

  res.redirect("/admin/login");
}

function requireStoreOperator(req, res, next) {
  if (req.session && req.session.isAdmin) {
    next();
    return;
  }

  if (resolvesToStoreManager(req)) {
    next();
    return;
  }

  res.redirect("/manager/login");
}

function getOperatorDashboardPath(req) {
  return resolvesToStoreManager(req) ? "/manager/dashboard" : "/admin/orders";
}

function buildOperatorRedirect(req, { tab = "", message = "", error = "", storeId = null } = {}) {
  const params = new URLSearchParams();
  if (tab) {
    params.set("tab", String(tab));
  }
  if (message) {
    params.set("message", String(message));
  }
  if (error) {
    params.set("error", String(error));
  }
  if (!resolvesToStoreManager(req) && Number.isInteger(Number(storeId)) && Number(storeId) > 0) {
    params.set("storeId", String(storeId));
  }

  const query = params.toString();
  return `${getOperatorDashboardPath(req)}${query ? `?${query}` : ""}`;
}

async function renderOperatorDashboard(req, res) {
  const isPlatformAdmin = Boolean(req.session && req.session.isAdmin);
  const activeStoreId = getOperatorStoreId(req);
  const currentStore = getStoreById(activeStoreId) || getPlatformDefaultStore();
  if (!currentStore) {
    throw new Error("No store is configured yet.");
  }

  const stores = isPlatformAdmin
    ? getStores().map((store) => ({
        ...store,
        manager: store.managerUserId ? getStoreManagerPublicById(store.managerUserId) : null,
      }))
    : [
        {
          ...currentStore,
          manager: currentStore.managerUserId ? getStoreManagerPublicById(currentStore.managerUserId) : null,
        },
      ];

  const orders = getOrders(currentStore.id);
  const items = getItems(currentStore.id);
  const analytics = buildAdminAnalytics({ orders, items });
  const inventoryItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const paymongoCheckout = getPaymongoCheckoutLinks(currentStore.id);
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const adminNotifications = getAdminNotificationSettings(currentStore.id);
  const smtpSettings = getSmtpSettings(currentStore.id);
  const facebookAutoPost = getFacebookAutoPostConfig(currentStore.id);
  const smtpStatus = getSmtpConfigStatus();

  await sendPendingOrderReminders(orders, currentStore.id);
  const activeOrders = orders.filter((order) => !order.isArchived);
  const archivedOrders = orders.filter((order) => order.isArchived);
  const pendingOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.PENDING);
  const paidOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.PAID);
  const forDeliveryOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.FOR_DELIVERY);
  const receivedOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.RECEIVED);

  res.render("admin-orders", {
    ...getStoreRenderContext(currentStore),
    items,
    inventoryItems,
    inventoryCategories: Object.values(ITEM_CATEGORIES),
    analytics,
    paymongoCheckout,
    baseUrl,
    adminNotifications,
    smtpSettings,
    pendingReminderHours: UNPROCESSED_ORDER_REMINDER_HOURS,
    smtpStatus,
    facebookAutoPost,
    facebookPostTime: toTimeInput(facebookAutoPost.hour, facebookAutoPost.minute),
    pendingOrders,
    paidOrders,
    forDeliveryOrders,
    receivedOrders,
    archivedOrders,
    message: req.query.message || "",
    error: req.query.error || "",
    isPlatformAdmin,
    operatorDashboardPath: getOperatorDashboardPath(req),
    currentStore,
    stores,
    currentStoreManager: currentStore.managerUserId ? getStoreManagerPublicById(currentStore.managerUserId) : null,
  });
}

let facebookAutoPostTask = null;
let pendingReminderTask = null;

function toBaseUrlFromRequest(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function parseTimeInput(value, fallbackHour, fallbackMinute) {
  const text = String(value || "").trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function toTimeInput(hour, minute) {
  const hh = String(Number(hour) || 0).padStart(2, "0");
  const mm = String(Number(minute) || 0).padStart(2, "0");
  return `${hh}:${mm}`;
}

function clampItemsPerPost(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_FACEBOOK_AUTO_POST.itemsPerPost;
  }
  if (parsed < 1) {
    return 1;
  }
  if (parsed > 6) {
    return 6;
  }
  return parsed;
}

function parseTriStateBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function normalizeFacebookToken(value) {
  let token = String(value || "").trim();
  token = token.replace(/^bearer\s+/i, "");
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token.replace(/\s+/g, "");
}

function looksLikeFacebookAccessToken(value) {
  const token = String(value || "").trim();
  return /^EA[A-Za-z0-9]/.test(token) && token.length >= 60;
}

function getFacebookConnectRedirectUri(req, config) {
  const configured = String((config && config.loginRedirectUri) || "").trim();
  if (configured) {
    return configured;
  }
  return `${process.env.PUBLIC_BASE_URL || toBaseUrlFromRequest(req)}/admin/facebook/connect/callback`;
}

function buildFacebookLoginUrl(req, config) {
  const appId = String((config && config.appId) || "").trim();
  if (!appId) {
    throw new Error("Facebook App ID is required before connecting Facebook login.");
  }

  const redirectUri = getFacebookConnectRedirectUri(req, config);
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: "pages_show_list,pages_read_engagement,pages_manage_posts",
    response_type: "code",
  });

  return `https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`;
}

function getSelectedFacebookPage(config, selectedPageId) {
  const pages = Array.isArray(config && config.availablePages) ? config.availablePages : [];
  if (!selectedPageId) {
    return null;
  }
  return pages.find((page) => String(page.id) === String(selectedPageId)) || null;
}

function isValidEmail(value) {
  const normalized = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function toSafeRedirectPath(value, fallback = "/") {
  const text = String(value || "").trim();
  if (!text || !text.startsWith("/") || text.startsWith("//")) {
    return fallback;
  }
  return text;
}

function isValidHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function toAbsoluteUrl(baseUrl, value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  if (isValidHttpUrl(text)) {
    return text;
  }

  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    return text;
  }

  return `${normalizedBaseUrl}/${text.replace(/^\/+/, "")}`;
}

function buildProductShareMeta(item, baseUrl, storeBasePath = "") {
  const name = String((item && item.name) || "Pre-loved by Lhota").trim();
  const description = String((item && item.description) || "").trim() || "Curated preloved pieces from Pre-loved by Lhota.";
  const basePath = String(storeBasePath || "").replace(/\/+$/, "");
  const url = `${String(baseUrl || "").replace(/\/+$/, "")}${basePath}/product/${encodeURIComponent(String(item && item.id || ""))}`;
  const image = toAbsoluteUrl(baseUrl, item && item.imageUrl);

  return {
    description,
    canonicalUrl: url,
    ogType: "product",
    ogTitle: `${name} | Pre-loved by Lhota`,
    ogDescription: description,
    ogUrl: url,
    ogImage: image,
    twitterCard: image ? "summary_large_image" : "summary",
  };
}

function inferMimeTypeFromFilename(filename) {
  const ext = String(path.extname(String(filename || "")).toLowerCase());
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return map[ext] || "";
}

function normalizeImageProcessMode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(IMAGE_PROCESS_MODES, normalized)) {
    return IMAGE_PROCESS_MODES[normalized];
  }
  return IMAGE_PROCESS_MODES.ORIGINAL;
}

function sampleBackgroundColor(pixelBuffer, info) {
  const sampleRadius = Math.max(2, Math.min(12, Math.floor(Math.min(info.width, info.height) / 12) || 2));
  const corners = [
    { startX: 0, endX: sampleRadius, startY: 0, endY: sampleRadius },
    { startX: Math.max(0, info.width - sampleRadius), endX: info.width, startY: 0, endY: sampleRadius },
    { startX: 0, endX: sampleRadius, startY: Math.max(0, info.height - sampleRadius), endY: info.height },
    { startX: Math.max(0, info.width - sampleRadius), endX: info.width, startY: Math.max(0, info.height - sampleRadius), endY: info.height },
  ];
  const totals = { r: 0, g: 0, b: 0, count: 0 };

  corners.forEach((corner) => {
    for (let y = corner.startY; y < corner.endY; y += 1) {
      for (let x = corner.startX; x < corner.endX; x += 1) {
        const idx = (y * info.width + x) * info.channels;
        const alpha = pixelBuffer[idx + 3];
        if (alpha < 24) {
          continue;
        }
        totals.r += pixelBuffer[idx];
        totals.g += pixelBuffer[idx + 1];
        totals.b += pixelBuffer[idx + 2];
        totals.count += 1;
      }
    }
  });

  if (!totals.count) {
    return { r: 245, g: 245, b: 245 };
  }

  return {
    r: Math.round(totals.r / totals.count),
    g: Math.round(totals.g / totals.count),
    b: Math.round(totals.b / totals.count),
  };
}

function removeBackgroundFromRawPixels(pixelBuffer, info) {
  const output = Buffer.from(pixelBuffer);
  const background = sampleBackgroundColor(output, info);
  const threshold = 42;
  const fadeRange = 92;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const idx = (y * info.width + x) * info.channels;
      const red = output[idx];
      const green = output[idx + 1];
      const blue = output[idx + 2];
      const currentAlpha = output[idx + 3];
      const distance = Math.sqrt(
        ((red - background.r) ** 2) +
        ((green - background.g) ** 2) +
        ((blue - background.b) ** 2)
      );

      if (distance <= threshold) {
        output[idx + 3] = 0;
        continue;
      }

      if (distance < fadeRange) {
        const normalized = (distance - threshold) / (fadeRange - threshold);
        output[idx + 3] = Math.max(0, Math.min(255, Math.round(currentAlpha * normalized)));
      }
    }
  }

  return output;
}

async function processItemUploadImage(file, imageProcessMode) {
  const mode = normalizeImageProcessMode(imageProcessMode);
  if (!file || !file.buffer || mode === IMAGE_PROCESS_MODES.ORIGINAL) {
    return file;
  }

  const input = sharp(file.buffer, { failOn: "none" }).rotate().ensureAlpha();
  const { data, info } = await input.raw().toBuffer({ resolveWithObject: true });
  const processedRaw = removeBackgroundFromRawPixels(data, info);

  let pipeline = sharp(processedRaw, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  });

  if (mode === IMAGE_PROCESS_MODES.CLEAN_WHITE) {
    pipeline = pipeline.flatten({ background: { r: 250, g: 248, b: 244 } });
  }

  const outputBuffer = await pipeline.png().toBuffer();
  const originalBaseName = String((file.originalname || "upload").replace(/\.[^.]+$/, "")).replace(/[^a-z0-9_-]/gi, "-") || "upload";

  return {
    ...file,
    buffer: outputBuffer,
    originalname: `${originalBaseName}.png`,
    mimetype: "image/png",
  };
}

async function resolveItemImageInput({ file, imageUrl, fallbackImageUrl = "", imageProcessMode = "" }) {
  if (file) {
    const nextFile = await processItemUploadImage(file, imageProcessMode);
    return storeUploadedFile({ file: nextFile, folder: "items" });
  }

  const typedImageUrl = String(imageUrl || "").trim();
  if (typedImageUrl) {
    return typedImageUrl;
  }

  const existingImageUrl = String(fallbackImageUrl || "").trim();
  if (existingImageUrl) {
    return existingImageUrl;
  }

  throw new Error("Please upload a photo or provide an image URL.");
}

function buildAdminAnalytics({ orders, items }) {
  const activeOrders = orders.filter((order) => !order.isArchived);
  const revenueOrders = activeOrders.filter((order) => {
    const status = String(order.status || "").toUpperCase();
    return status === ORDER_STATUSES.PAID ||
      status === ORDER_STATUSES.FOR_DELIVERY ||
      status === ORDER_STATUSES.RECEIVED;
  });

  const totalRevenue = revenueOrders.reduce((sum, order) => sum + Number(order.grandTotal || order.totalAmount || 0), 0);
  const totalDeliveryFees = revenueOrders.reduce((sum, order) => sum + Number(order.deliveryFee || 0), 0);
  const totalItemSales = revenueOrders.reduce((sum, order) => sum + Number(order.itemSubtotal || 0), 0);
  const totalUnitsSold = revenueOrders.reduce(
    (sum, order) => sum + (Array.isArray(order.items) ? order.items.reduce((itemSum, item) => itemSum + (Number(item.quantity) || 0), 0) : 0),
    0
  );

  const statusCounts = {
    pending: activeOrders.filter((order) => order.status === ORDER_STATUSES.PENDING).length,
    paid: activeOrders.filter((order) => order.status === ORDER_STATUSES.PAID).length,
    forDelivery: activeOrders.filter((order) => order.status === ORDER_STATUSES.FOR_DELIVERY).length,
    received: activeOrders.filter((order) => order.status === ORDER_STATUSES.RECEIVED).length,
  };

  const categoryMap = new Map();
  const itemMap = new Map();
  for (const order of revenueOrders) {
    for (const orderItem of order.items || []) {
      const quantity = Number(orderItem.quantity) || 0;
      const subtotal = Number(orderItem.subtotal) || 0;
      const categoryKey = String(orderItem.category || "Other");
      const itemKey = String(orderItem.itemId || orderItem.name || "");

      const categoryEntry = categoryMap.get(categoryKey) || { name: categoryKey, units: 0, revenue: 0 };
      categoryEntry.units += quantity;
      categoryEntry.revenue += subtotal;
      categoryMap.set(categoryKey, categoryEntry);

      const itemEntry = itemMap.get(itemKey) || {
        id: String(orderItem.itemId || ""),
        name: String(orderItem.name || "Unknown item"),
        units: 0,
        revenue: 0,
      };
      itemEntry.units += quantity;
      itemEntry.revenue += subtotal;
      itemMap.set(itemKey, itemEntry);
    }
  }

  const topCategories = [...categoryMap.values()]
    .sort((a, b) => b.revenue - a.revenue || b.units - a.units || a.name.localeCompare(b.name))
    .slice(0, 3);

  const topItems = [...itemMap.values()]
    .sort((a, b) => b.units - a.units || b.revenue - a.revenue || a.name.localeCompare(b.name))
    .slice(0, 5);

  const lowStockItems = [...items]
    .filter((item) => !item.isBlocked && Number(item.stock) <= 2)
    .sort((a, b) => Number(a.stock) - Number(b.stock) || a.name.localeCompare(b.name));

  const latestOrders = [...activeOrders]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  return {
    totalRevenue,
    totalDeliveryFees,
    totalItemSales,
    totalUnitsSold,
    orderCount: activeOrders.length,
    itemCount: items.length,
    activeItemCount: items.filter((item) => !item.isBlocked).length,
    blockedItemCount: items.filter((item) => item.isBlocked).length,
    lowStockItems,
    latestOrders,
    topCategories,
    topItems,
    statusCounts,
  };
}

function extractOutputTextFromResponsesApi(payload) {
  if (payload && typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (!payload || !Array.isArray(payload.output)) {
    return "";
  }

  for (const block of payload.output) {
    const content = Array.isArray(block && block.content) ? block.content : [];
    for (const part of content) {
      if (part && typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return "";
}

function normalizeSuggestedName(value) {
  let text = String(value || "").trim();
  if (!text) {
    return "";
  }

  text = text.replace(/^["'`]+|["'`]+$/g, "");
  text = text.replace(/^product\s*name\s*[:\-]\s*/i, "");
  text = text.replace(/^suggested\s*name\s*[:\-]\s*/i, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 120) {
    text = text.slice(0, 120).trim();
  }
  return text;
}

async function suggestProductNameFromImage(payload) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Add it in .env to use AI name generation.");
  }

  const imageBase64FromPayload = String((payload && payload.imageBase64) || "").trim();
  const imagePath = String((payload && payload.imagePath) || "").trim();
  const mimeType = String((payload && payload.mimeType) || "").trim() || inferMimeTypeFromFilename(imagePath);
  if (!mimeType.startsWith("image/")) {
    throw new Error("Uploaded file must be a valid image.");
  }

  let imageBase64 = imageBase64FromPayload;
  if (!imageBase64) {
    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new Error("Uploaded image file was not found.");
    }
    imageBase64 = fs.readFileSync(imagePath, "base64");
  }

  const model = String(process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();
  const apiBase = String(process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

  const response = await fetch(`${apiBase}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_output_tokens: 50,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Generate one concise product name for a pre-loved e-commerce listing. Use title case, plain text only, 3-8 words, no emojis, no hashtags.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Category: ${String((payload && payload.category) || "").trim() || "Unknown"}\nCurrent Name: ${String((payload && payload.currentName) || "").trim() || "N/A"}\nReturn only the best product name.`,
            },
            {
              type: "input_image",
              image_url: `data:${mimeType};base64,${imageBase64}`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI name generation failed (${response.status}): ${errorText.slice(0, 180)}`);
  }

  const data = await response.json();
  const suggestion = normalizeSuggestedName(extractOutputTextFromResponsesApi(data));
  if (!suggestion) {
    throw new Error("AI returned an empty name. Try another image.");
  }

  return suggestion;
}

function getOrderAgeHours(order) {
  const createdAt = new Date(order.createdAt).getTime();
  if (!Number.isFinite(createdAt)) {
    return 0;
  }

  const elapsedMs = Date.now() - createdAt;
  return Math.max(0, Math.floor(elapsedMs / (1000 * 60 * 60)));
}

function isPendingTooLong(order) {
  if (order.isArchived) {
    return false;
  }

  if (String(order.status || "").toUpperCase() !== ORDER_STATUSES.PENDING) {
    return false;
  }

  return getOrderAgeHours(order) >= UNPROCESSED_ORDER_REMINDER_HOURS;
}

async function sendPendingOrderReminders(orders, storeId = null) {
  const notificationSettings = getAdminNotificationSettings(storeId);
  if (!notificationSettings.enabled || !notificationSettings.newOrderEmail) {
    return { checked: 0, sent: 0 };
  }

  const overdueOrders = orders.filter((order) => {
    return isPendingTooLong(order) && !order.pendingReminderNotifiedAt;
  });

  let sentCount = 0;
  for (const order of overdueOrders) {
    try {
      const ageHours = getOrderAgeHours(order);
      const sent = await sendUnprocessedOrderReminderEmail(
        notificationSettings.newOrderEmail,
        order,
        ageHours
      );
      if (sent) {
        markOrderPendingReminderNotified(order.id, storeId);
        sentCount += 1;
      }
    } catch (error) {
      console.error(`Failed to send pending reminder for order #${order.id}:`, error.message);
    }
  }

  return {
    checked: overdueOrders.length,
    sent: sentCount,
  };
}

async function runPendingReminderScan() {
  const summaries = [];
  for (const store of getStores()) {
    const orders = getOrders(store.id);
    const result = await sendPendingOrderReminders(orders, store.id);
    summaries.push({ storeId: store.id, ...result });
  }
  return summaries;
}

function startPendingReminderCron() {
  if (pendingReminderTask) {
    pendingReminderTask.stop();
    pendingReminderTask.destroy();
    pendingReminderTask = null;
  }

  pendingReminderTask = cron.schedule(
    "0 * * * *",
    async () => {
      try {
        await runPendingReminderScan();
      } catch (error) {
        console.error("Pending order reminder cron failed:", error.message);
      }
    },
    { timezone: "Asia/Manila" }
  );
}

async function runFacebookAutoPost(triggeredBy = "cron", storeId = null) {
  const targetStoreId = storeId === null || storeId === undefined
    ? (getPlatformDefaultStore() ? getPlatformDefaultStore().id : null)
    : Number(storeId);
  const config = getFacebookAutoPostConfig(targetStoreId);

  if (!config.enabled && triggeredBy === "cron") {
    return { skipped: true, message: "Auto-post is disabled." };
  }

  try {
    const items = getPublicItems(getItems(targetStoreId));
    const result = await postRandomItemsToFacebook(config, items);
    setFacebookAutoPostLastResult({
      status: "SUCCESS",
      message: `Posted ${result.pickedItems.length} random item(s) to Facebook.`,
      postId: result.postId,
      postedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      triggeredBy,
    }, targetStoreId);

    return { skipped: false, message: "Facebook auto-post completed.", ...result };
  } catch (error) {
    setFacebookAutoPostLastResult({
      status: "ERROR",
      message: error.message || "Facebook auto-post failed.",
      attemptedAt: new Date().toISOString(),
      triggeredBy,
    }, targetStoreId);
    throw error;
  }
}

function rescheduleFacebookAutoPost() {
  if (facebookAutoPostTask) {
    facebookAutoPostTask.stop();
    facebookAutoPostTask.destroy();
    facebookAutoPostTask = null;
  }

  const stores = getStores();
  const hasEnabledStore = stores.some((store) => getFacebookAutoPostConfig(store.id).enabled);
  if (!hasEnabledStore) {
    return stores.map((store) => getFacebookAutoPostConfig(store.id));
  }

  const expression = "* * * * *";
  try {
    facebookAutoPostTask = cron.schedule(
      expression,
      async () => {
        const now = new Date();

        for (const store of stores) {
          const config = getFacebookAutoPostConfig(store.id);
          if (!config.enabled) {
            continue;
          }

          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: config.timezone || "Asia/Manila",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          const parts = formatter.formatToParts(now);
          const hour = Number(parts.find((part) => part.type === "hour")?.value || -1);
          const minute = Number(parts.find((part) => part.type === "minute")?.value || -1);
          if (hour !== Number(config.hour) || minute !== Number(config.minute)) {
            continue;
          }

          const lastAttemptMinute = String(config.lastAttemptAt || "").slice(0, 16);
          const currentMinuteMarker = new Date(now.getTime()).toISOString().slice(0, 16);
          if (lastAttemptMinute === currentMinuteMarker) {
            continue;
          }

          try {
            await runFacebookAutoPost("cron", store.id);
          } catch (error) {
            console.error(`Facebook cron post failed for store #${store.id}:`, error.message);
          }
        }
      },
      { timezone: "UTC" }
    );
  } catch (error) {
    console.error("Failed to schedule Facebook auto-post cron:", error.message);
    setFacebookAutoPostLastResult({
      status: "ERROR",
      message: `Invalid cron settings: ${error.message}`,
      attemptedAt: new Date().toISOString(),
      triggeredBy: "scheduler",
    }, getPlatformDefaultStore() ? getPlatformDefaultStore().id : null);
  }

  return stores.map((store) => getFacebookAutoPostConfig(store.id));
}

function toCategoryKey(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

  const aliases = {
    BUGS: "BAGS",
    BAG: "BAGS",
    CLOTHING: "CLOTHES",
    CLOTHINGS: "CLOTHES",
    MISC: "MISCELLANEOUS",
    UTENSILS: "MISCELLANEOUS",
  };

  return aliases[normalized] || normalized;
}

function categoryLabelFromKey(value) {
  const key = toCategoryKey(value);
  const labels = {
    CLOTHES: "Clothes",
    BAGS: "Bags",
    MISCELLANEOUS: "Miscellaneous",
  };
  return labels[key] || String(value || "").trim();
}

function sortItems(list, sortBy) {
  const items = [...list];

  if (sortBy === "name_desc") {
    return items.sort((a, b) => b.name.localeCompare(a.name));
  }

  if (sortBy === "price_asc") {
    return items.sort((a, b) => a.price - b.price);
  }

  if (sortBy === "price_desc") {
    return items.sort((a, b) => b.price - a.price);
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function getPublicItems(list) {
  return (Array.isArray(list) ? list : []).filter((item) => !item.isBlocked);
}

function getResolvedStore(storeLike) {
  return storeLike || getPlatformDefaultStore();
}

function getStoreFromSlugOrDefault(req) {
  const slug = String(req.params && req.params.slug ? req.params.slug : "").trim();
  if (!slug) {
    return getPlatformDefaultStore();
  }
  return getStoreBySlug(slug);
}

function getStoreFromRedirectPath(value) {
  const pathValue = toSafeRedirectPath(value, "");
  const match = pathValue.match(/^\/stores\/([^/?#]+)/i);
  if (!match) {
    return getPlatformDefaultStore();
  }
  return getStoreBySlug(decodeURIComponent(match[1])) || getPlatformDefaultStore();
}

function getStoreOrRedirect(req, res) {
  const store = getStoreFromSlugOrDefault(req);
  if (!store) {
    res.redirect("/");
    return null;
  }
  return store;
}

function withStoreContext(store, values = {}) {
  return {
    ...getStoreRenderContext(store),
    ...values,
  };
}

function getStoreItems(store) {
  return getItems(store ? store.id : null);
}

function buildShopViewModel(req, store) {
  const items = getPublicItems(getStoreItems(store));
  const categoryMap = new Map();
  items.forEach((item) => {
    const key = toCategoryKey(item.category);
    if (!categoryMap.has(key)) {
      categoryMap.set(key, categoryLabelFromKey(item.category));
    }
  });
  const categories = Array.from(categoryMap.values());

  const q = String(req.query.q || "").trim();
  const requestedCategoryKey = toCategoryKey(req.query.category || "ALL");
  const selectedCategoryKey =
    requestedCategoryKey === "ALL" || categoryMap.has(requestedCategoryKey)
      ? requestedCategoryKey
      : "ALL";
  const selectedCategory =
    selectedCategoryKey === "ALL" ? "ALL" : categoryMap.get(selectedCategoryKey);

  const minPriceValue = req.query.minPrice;
  const maxPriceValue = req.query.maxPrice;
  const minPrice = minPriceValue === undefined || minPriceValue === "" ? null : Number(minPriceValue);
  const maxPrice = maxPriceValue === undefined || maxPriceValue === "" ? null : Number(maxPriceValue);
  const inStockOnly = String(req.query.inStock || "") === "1";
  const sortBy = String(req.query.sort || "name_asc");

  let filteredItems = [...items];

  if (selectedCategoryKey !== "ALL") {
    filteredItems = filteredItems.filter((item) => toCategoryKey(item.category) === selectedCategoryKey);
  }

  if (q) {
    const query = q.toLowerCase();
    filteredItems = filteredItems.filter((item) => {
      return (
        item.name.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query)
      );
    });
  }

  if (Number.isFinite(minPrice)) {
    filteredItems = filteredItems.filter((item) => item.price >= Number(minPrice));
  }

  if (Number.isFinite(maxPrice)) {
    filteredItems = filteredItems.filter((item) => item.price <= Number(maxPrice));
  }

  if (inStockOnly) {
    filteredItems = filteredItems.filter((item) => item.stock > 0);
  }

  filteredItems = sortItems(filteredItems, sortBy);

  return {
    items,
    filteredItems,
    categories,
    selectedCategory,
    selectedCategoryKey,
    filters: {
      q,
      minPrice: Number.isFinite(minPrice) ? String(minPrice) : "",
      maxPrice: Number.isFinite(maxPrice) ? String(maxPrice) : "",
      inStockOnly,
      sortBy,
    },
    resultsCount: filteredItems.length,
    totalCount: items.length,
  };
}

function renderStoreHome(req, res, store) {
  const activeStore = getResolvedStore(store);
  const items = getPublicItems(getStoreItems(activeStore));
  res.render("index", withStoreContext(activeStore, { items }));
}

function renderStoreShop(req, res, store) {
  const activeStore = getResolvedStore(store);
  const model = buildShopViewModel(req, activeStore);
  res.render(
    "shop",
    withStoreContext(activeStore, {
      items: model.filteredItems,
      allItemsJson: JSON.stringify(model.items),
      categories: model.categories,
      selectedCategory: model.selectedCategory,
      selectedCategoryKey: model.selectedCategoryKey,
      filters: model.filters,
      resultsCount: model.resultsCount,
      totalCount: model.totalCount,
    })
  );
}

function renderStoreProduct(req, res, store) {
  const activeStore = getResolvedStore(store);
  const itemId = String(req.params.itemId || "");
  const items = getPublicItems(getStoreItems(activeStore));
  const item = items.find((entry) => entry.id === itemId);

  if (!item) {
    res.redirect(`${buildStoreBasePath(activeStore)}/shop`);
    return;
  }

  const relatedItems = items
    .filter((entry) => entry.id !== item.id && entry.category === item.category)
    .slice(0, 4);
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

  res.render(
    "product-detail",
    withStoreContext(activeStore, {
      item,
      relatedItems,
      baseUrl,
      meta: buildProductShareMeta(item, baseUrl, buildStoreBasePath(activeStore)),
      error: String(req.query.error || ""),
      allItemsJson: JSON.stringify(items),
    })
  );
}

function renderStorePaymentWaiting(req, res, store) {
  const activeStore = getResolvedStore(store);
  const itemId = String(req.params.itemId || "");
  const items = getPublicItems(getStoreItems(activeStore));
  const item = items.find((entry) => entry.id === itemId);

  if (!item) {
    res.redirect(`${buildStoreBasePath(activeStore)}/shop`);
    return;
  }

  if (!item.paymongoLink) {
    res.redirect(
      `${buildStoreBasePath(activeStore)}/product/${encodeURIComponent(item.id)}?error=${encodeURIComponent(
        "PayMongo link is not configured for this product yet."
      )}`
    );
    return;
  }

  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const callbackUrl =
    `${baseUrl}${buildStoreBasePath(activeStore)}/payment/callback?itemId=${encodeURIComponent(item.id)}`;
  res.render("payment-waiting", withStoreContext(activeStore, { item, callbackUrl }));
}

function renderStorePaymentCallback(req, res, store) {
  const activeStore = getResolvedStore(store);
  const itemId = String(req.query.itemId || "").trim();
  const status = String(req.query.status || "pending").trim().toUpperCase();
  const items = getPublicItems(getStoreItems(activeStore));
  const item = items.find((entry) => entry.id === itemId) || null;
  const statusLabelMap = {
    PAID: "Paid",
    SUCCESS: "Paid",
    FAILED: "Failed",
    CANCELLED: "Cancelled",
    PENDING: "Pending",
  };
  const statusLabel = statusLabelMap[status] || "Pending";

  res.render("payment-callback", withStoreContext(activeStore, { item, status, statusLabel }));
}

function renderStoreCart(req, res, store, extra = {}) {
  const activeStore = getResolvedStore(store);
  const items = getPublicItems(getStoreItems(activeStore));
  const paymongoCheckout = getPaymongoCheckoutLinks(activeStore.id);
  res.render(
    "cart",
    withStoreContext(activeStore, {
      items,
      itemsJson: JSON.stringify(items),
      deliveryFees: DELIVERY_FEES,
      paymongoCheckout,
      error: "",
      buyerUser: res.locals.buyerUser || null,
      ...extra,
    })
  );
}

function redirectToStoreCategory(store, categoryKey) {
  const basePath = buildStoreBasePath(store);
  return `${basePath}/shop?category=${encodeURIComponent(categoryKey)}`;
}

app.get("/", (req, res) => {
  renderStoreHome(req, res, getPlatformDefaultStore());
});

app.get("/signup", (req, res) => {
  if (res.locals.buyerUser) {
    res.redirect(toSafeRedirectPath(req.query.redirectTo, "/"));
    return;
  }

  res.render("user-signup", withStoreContext(getStoreFromRedirectPath(req.query.redirectTo), {
    error: "",
    form: {
      fullName: "",
      email: "",
      phone: "",
    },
    redirectTo: toSafeRedirectPath(req.query.redirectTo, "/"),
  }));
});

app.post("/signup", (req, res) => {
  try {
    const redirectTo = toSafeRedirectPath(req.body.redirectTo, "/");
    if (res.locals.buyerUser) {
      res.redirect(redirectTo);
      return;
    }

    const fullName = String(req.body.fullName || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");
    const passwordConfirm = String(req.body.passwordConfirm || "");

    if (!fullName || !email || !phone || !password || !passwordConfirm) {
      throw new Error("Please complete all sign up fields.");
    }

    if (!isValidEmail(email)) {
      throw new Error("Please provide a valid email address.");
    }

    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }

    if (password !== passwordConfirm) {
      throw new Error("Passwords do not match.");
    }

    const buyer = createBuyerAccount({
      email,
      fullName,
      phone,
      password,
    });

    req.session.buyerUserId = buyer.id;
    res.redirect(redirectTo);
  } catch (error) {
    res.status(400).render("user-signup", withStoreContext(getStoreFromRedirectPath(req.body.redirectTo), {
      error: error.message || "Failed to sign up.",
      form: {
        fullName: String(req.body.fullName || "").trim(),
        email: String(req.body.email || "").trim(),
        phone: String(req.body.phone || "").trim(),
      },
      redirectTo: toSafeRedirectPath(req.body.redirectTo, "/"),
    }));
  }
});

app.get("/login", (req, res) => {
  if (res.locals.buyerUser) {
    res.redirect(toSafeRedirectPath(req.query.redirectTo, "/"));
    return;
  }

  res.render("user-login", withStoreContext(getStoreFromRedirectPath(req.query.redirectTo), {
    error: "",
    message: String(req.query.message || ""),
    email: "",
    redirectTo: toSafeRedirectPath(req.query.redirectTo, "/"),
  }));
});

app.post("/login", (req, res) => {
  try {
    const redirectTo = toSafeRedirectPath(req.body.redirectTo, "/");
    if (res.locals.buyerUser) {
      res.redirect(redirectTo);
      return;
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
      throw new Error("Email and password are required.");
    }

    const buyer = authenticateBuyerAccount(email, password);
    if (!buyer) {
      throw new Error("Invalid email or password.");
    }

    req.session.buyerUserId = buyer.id;
    res.redirect(redirectTo);
  } catch (error) {
    res.status(401).render("user-login", withStoreContext(getStoreFromRedirectPath(req.body.redirectTo), {
      error: error.message || "Login failed.",
      message: "",
      email: String(req.body.email || "").trim(),
      redirectTo: toSafeRedirectPath(req.body.redirectTo, "/"),
    }));
  }
});

app.get("/logout", (req, res) => {
  const nextPath = toSafeRedirectPath(req.query.next, "/");
  if (req.session) {
    delete req.session.buyerUserId;
  }
  res.redirect(nextPath);
});

app.get("/shop", (req, res) => {
  renderStoreShop(req, res, getPlatformDefaultStore());
});

app.get("/shop/clothes", (_req, res) => {
  res.redirect("/shop?category=CLOTHES");
});

app.get("/shop/bags", (_req, res) => {
  res.redirect("/shop?category=BAGS");
});

app.get("/shop/bugs", (_req, res) => {
  res.redirect("/shop?category=BAGS");
});

app.get("/shop/miscellaneous", (_req, res) => {
  res.redirect("/shop?category=MISCELLANEOUS");
});

app.get("/clothes", (_req, res) => {
  res.redirect("/shop/clothes");
});

app.get("/bags", (_req, res) => {
  res.redirect("/shop/bags");
});

app.get("/miscellaneous", (_req, res) => {
  res.redirect("/shop/miscellaneous");
});

app.get("/product/:itemId", (req, res) => {
  renderStoreProduct(req, res, getPlatformDefaultStore());
});

app.get("/payment/waiting/:itemId", (req, res) => {
  renderStorePaymentWaiting(req, res, getPlatformDefaultStore());
});

app.get("/payment/callback", (req, res) => {
  renderStorePaymentCallback(req, res, getPlatformDefaultStore());
});

app.get("/cart", (req, res) => {
  renderStoreCart(req, res, getPlatformDefaultStore(), {
    error: req.query.error || "",
  });
});

app.get("/buy/:itemId", (req, res) => {
  const itemId = String(req.params.itemId || "");
  const activeStore = getPlatformDefaultStore();
  const items = getPublicItems(getStoreItems(activeStore));
  const item = items.find((entry) => entry.id === itemId);

  if (!item) {
    res.redirect("/");
    return;
  }

  let quantity = Number(req.query.qty || 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    quantity = 1;
  }

  if (item.stock > 0) {
    quantity = Math.min(quantity, item.stock);
  }

  res.redirect(`/cart?buyItem=${encodeURIComponent(item.id)}&qty=${quantity}`);
});

app.post("/checkout", upload.single("paymentProof"), async (req, res) => {
  const activeStore = getPlatformDefaultStore();
  const items = getPublicItems(getStoreItems(activeStore));

  try {
    const {
      buyerName,
      buyerEmail,
      buyerPhone,
      deliveryRegionCode,
      deliveryRegion,
      deliveryCityCode,
      deliveryCity,
      deliveryBarangayCode,
      deliveryBarangay,
      deliveryAddressLine,
      deliveryArea,
      deliveryAddress,
      gcashNumber,
      gcashReference,
      checkoutMode,
      accountPassword,
      accountPasswordConfirm,
      cartData,
    } = req.body;

    if (
      !buyerName ||
      !buyerEmail ||
      !buyerPhone ||
      !deliveryRegionCode ||
      !deliveryRegion ||
      !deliveryCityCode ||
      !deliveryCity ||
      !deliveryBarangayCode ||
      !deliveryBarangay ||
      !deliveryAddressLine ||
      !gcashNumber ||
      !gcashReference
    ) {
      throw new Error("Please complete all checkout fields.");
    }

    const composedDeliveryAddress = [
      String(deliveryAddressLine || "").trim(),
      String(deliveryBarangay || "").trim(),
      String(deliveryCity || "").trim(),
      String(deliveryRegion || "").trim(),
    ]
      .filter(Boolean)
      .join(", ");

    if (!req.file) {
      throw new Error("Please upload your payment screenshot.");
    }

    let parsedCart;
    try {
      parsedCart = JSON.parse(cartData);
    } catch (_error) {
      throw new Error("Invalid cart data.");
    }

    const sanitizedItems = parsedCart
      .map((entry) => ({
        itemId: String(entry.itemId),
        quantity: Number(entry.quantity),
      }))
      .filter((entry) => entry.itemId && Number.isFinite(entry.quantity) && entry.quantity > 0);

    const normalizedCheckoutMode =
      String(checkoutMode || CHECKOUT_MODES.GUEST).toUpperCase() === CHECKOUT_MODES.CREATE_ACCOUNT
        ? CHECKOUT_MODES.CREATE_ACCOUNT
        : CHECKOUT_MODES.GUEST;

    let createdAccount = null;
    if (normalizedCheckoutMode === CHECKOUT_MODES.CREATE_ACCOUNT) {
      if (!accountPassword) {
        throw new Error("Please provide a password to create your account.");
      }

      if (String(accountPassword) !== String(accountPasswordConfirm || "")) {
        throw new Error("Account passwords do not match.");
      }

      createdAccount = createBuyerAccount({
        email: buyerEmail,
        fullName: buyerName,
        phone: buyerPhone,
        password: accountPassword,
      });
      req.session.buyerUserId = createdAccount.id;
    }

    const existingBuyer = getBuyerPublicById(req.session && req.session.buyerUserId);
    const buyerAccountId = createdAccount ? createdAccount.id : existingBuyer ? existingBuyer.id : null;

    const paymentProofPath = await storeUploadedFile({
      file: req.file,
      folder: "payments",
    });

    const order = createOrder({
      storeId: activeStore.id,
      buyerName,
      buyerEmail,
      buyerPhone,
      deliveryRegionCode,
      deliveryRegion,
      deliveryCityCode,
      deliveryCity,
      deliveryBarangayCode,
      deliveryBarangay,
      deliveryAddressLine,
      deliveryArea,
      deliveryAddress: composedDeliveryAddress || String(deliveryAddress || "").trim(),
      gcashNumber,
      gcashReference,
      checkoutMode: normalizedCheckoutMode,
      buyerAccountId,
      paymentProofPath,
      items: sanitizedItems,
    });

    let pendingEmailSent = false;
    try {
      pendingEmailSent = await sendPendingOrderEmail(order);
    } catch (mailError) {
      console.error("Failed to send pending order email:", mailError.message);
    }

    try {
      const notificationSettings = getAdminNotificationSettings(activeStore.id);
      if (notificationSettings.enabled && notificationSettings.newOrderEmail) {
        await sendNewOrderAdminEmail(notificationSettings.newOrderEmail, order);
      }
    } catch (mailError) {
      console.error("Failed to send new-order admin email:", mailError.message);
    }

    res.render("checkout-success", {
      order,
      pendingEmailSent,
      accountCreated: Boolean(createdAccount),
      ...getStoreRenderContext(activeStore),
    });
  } catch (error) {
    renderStoreCart(req, res, activeStore, {
      items,
      itemsJson: JSON.stringify(items),
      error: error.message || "Failed to submit order.",
    });
  }
});

app.get("/manager/login", (req, res) => {
  if (resolvesToStoreManager(req)) {
    res.redirect("/manager/dashboard");
    return;
  }

  res.render("manager-login", { error: String(req.query.error || "") });
});

app.post("/manager/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const manager = authenticateStoreManager(email, password);

  if (!manager) {
    res.status(401).render("manager-login", { error: "Invalid manager email or password." });
    return;
  }

  delete req.session.isAdmin;
  req.session.storeManagerUserId = manager.id;
  res.redirect("/manager/dashboard");
});

app.post("/manager/logout", (req, res) => {
  if (req.session) {
    delete req.session.storeManagerUserId;
  }
  res.redirect("/manager/login");
});

app.get("/manager/dashboard", requireStoreOperator, async (req, res) => {
  try {
    if (req.session && req.session.isAdmin) {
      res.redirect("/admin/orders");
      return;
    }
    await renderOperatorDashboard(req, res);
  } catch (error) {
    console.error("Manager dashboard failed to load:", error);
    const fallbackMessage = error && error.message
      ? `Manager dashboard failed to load: ${error.message}`
      : "Manager dashboard failed to load.";
    res.redirect(`/manager/login?error=${encodeURIComponent(fallbackMessage)}`);
  }
});

app.get("/stores/:slug", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  renderStoreHome(req, res, store);
});

app.get("/stores/:slug/shop", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  renderStoreShop(req, res, store);
});

app.get("/stores/:slug/shop/clothes", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  res.redirect(redirectToStoreCategory(store, "CLOTHES"));
});

app.get("/stores/:slug/shop/bags", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  res.redirect(redirectToStoreCategory(store, "BAGS"));
});

app.get("/stores/:slug/shop/bugs", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  res.redirect(redirectToStoreCategory(store, "BAGS"));
});

app.get("/stores/:slug/shop/miscellaneous", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  res.redirect(redirectToStoreCategory(store, "MISCELLANEOUS"));
});

app.get("/stores/:slug/clothes", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  res.redirect(`${buildStoreBasePath(store)}/shop/clothes`);
});

app.get("/stores/:slug/bags", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  res.redirect(`${buildStoreBasePath(store)}/shop/bags`);
});

app.get("/stores/:slug/miscellaneous", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  res.redirect(`${buildStoreBasePath(store)}/shop/miscellaneous`);
});

app.get("/stores/:slug/product/:itemId", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  renderStoreProduct(req, res, store);
});

app.get("/stores/:slug/payment/waiting/:itemId", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  renderStorePaymentWaiting(req, res, store);
});

app.get("/stores/:slug/payment/callback", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  renderStorePaymentCallback(req, res, store);
});

app.get("/stores/:slug/cart", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }
  renderStoreCart(req, res, store, { error: req.query.error || "" });
});

app.get("/stores/:slug/buy/:itemId", (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }

  const itemId = String(req.params.itemId || "");
  const items = getPublicItems(getStoreItems(store));
  const item = items.find((entry) => entry.id === itemId);

  if (!item) {
    res.redirect(buildStoreBasePath(store));
    return;
  }

  let quantity = Number(req.query.qty || 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    quantity = 1;
  }

  if (item.stock > 0) {
    quantity = Math.min(quantity, item.stock);
  }

  res.redirect(`${buildStoreBasePath(store)}/cart?buyItem=${encodeURIComponent(item.id)}&qty=${quantity}`);
});

app.post("/stores/:slug/checkout", upload.single("paymentProof"), async (req, res) => {
  const store = getStoreOrRedirect(req, res);
  if (!store) {
    return;
  }

  const items = getPublicItems(getStoreItems(store));

  try {
    const {
      buyerName,
      buyerEmail,
      buyerPhone,
      deliveryRegionCode,
      deliveryRegion,
      deliveryCityCode,
      deliveryCity,
      deliveryBarangayCode,
      deliveryBarangay,
      deliveryAddressLine,
      deliveryArea,
      deliveryAddress,
      gcashNumber,
      gcashReference,
      checkoutMode,
      accountPassword,
      accountPasswordConfirm,
      cartData,
    } = req.body;

    if (
      !buyerName ||
      !buyerEmail ||
      !buyerPhone ||
      !deliveryRegionCode ||
      !deliveryRegion ||
      !deliveryCityCode ||
      !deliveryCity ||
      !deliveryBarangayCode ||
      !deliveryBarangay ||
      !deliveryAddressLine ||
      !gcashNumber ||
      !gcashReference
    ) {
      throw new Error("Please complete all checkout fields.");
    }

    const composedDeliveryAddress = [
      String(deliveryAddressLine || "").trim(),
      String(deliveryBarangay || "").trim(),
      String(deliveryCity || "").trim(),
      String(deliveryRegion || "").trim(),
    ]
      .filter(Boolean)
      .join(", ");

    if (!req.file) {
      throw new Error("Please upload your payment screenshot.");
    }

    let parsedCart;
    try {
      parsedCart = JSON.parse(cartData);
    } catch (_error) {
      throw new Error("Invalid cart data.");
    }

    const sanitizedItems = parsedCart
      .map((entry) => ({
        itemId: String(entry.itemId),
        quantity: Number(entry.quantity),
      }))
      .filter((entry) => entry.itemId && Number.isFinite(entry.quantity) && entry.quantity > 0);

    const normalizedCheckoutMode =
      String(checkoutMode || CHECKOUT_MODES.GUEST).toUpperCase() === CHECKOUT_MODES.CREATE_ACCOUNT
        ? CHECKOUT_MODES.CREATE_ACCOUNT
        : CHECKOUT_MODES.GUEST;

    let createdAccount = null;
    if (normalizedCheckoutMode === CHECKOUT_MODES.CREATE_ACCOUNT) {
      if (!accountPassword) {
        throw new Error("Please provide a password to create your account.");
      }

      if (String(accountPassword) !== String(accountPasswordConfirm || "")) {
        throw new Error("Account passwords do not match.");
      }

      createdAccount = createBuyerAccount({
        email: buyerEmail,
        fullName: buyerName,
        phone: buyerPhone,
        password: accountPassword,
      });
      req.session.buyerUserId = createdAccount.id;
    }

    const existingBuyer = getBuyerPublicById(req.session && req.session.buyerUserId);
    const buyerAccountId = createdAccount ? createdAccount.id : existingBuyer ? existingBuyer.id : null;

    const paymentProofPath = await storeUploadedFile({
      file: req.file,
      folder: "payments",
    });

    const order = createOrder({
      storeId: store.id,
      buyerName,
      buyerEmail,
      buyerPhone,
      deliveryRegionCode,
      deliveryRegion,
      deliveryCityCode,
      deliveryCity,
      deliveryBarangayCode,
      deliveryBarangay,
      deliveryAddressLine,
      deliveryArea,
      deliveryAddress: composedDeliveryAddress || String(deliveryAddress || "").trim(),
      gcashNumber,
      gcashReference,
      checkoutMode: normalizedCheckoutMode,
      buyerAccountId,
      paymentProofPath,
      items: sanitizedItems,
    });

    let pendingEmailSent = false;
    try {
      pendingEmailSent = await sendPendingOrderEmail(order);
    } catch (mailError) {
      console.error("Failed to send pending order email:", mailError.message);
    }

    try {
      const notificationSettings = getAdminNotificationSettings(store.id);
      if (notificationSettings.enabled && notificationSettings.newOrderEmail) {
        await sendNewOrderAdminEmail(notificationSettings.newOrderEmail, order);
      }
    } catch (mailError) {
      console.error("Failed to send new-order admin email:", mailError.message);
    }

    res.render("checkout-success", {
      order,
      pendingEmailSent,
      accountCreated: Boolean(createdAccount),
      ...getStoreRenderContext(store),
    });
  } catch (error) {
    renderStoreCart(req, res, store, {
      items,
      itemsJson: JSON.stringify(items),
      error: error.message || "Failed to submit order.",
    });
  }
});

app.get("/admin/login", (req, res) => {
  if (resolvesToStoreManager(req)) {
    res.redirect("/manager/dashboard");
    return;
  }

  if (req.session && req.session.isAdmin) {
    res.redirect("/admin/orders");
    return;
  }

  res.render("admin-login", { error: String(req.query.error || "") });
});

app.post("/admin/login", (req, res) => {
  const { email, password } = req.body;
  const admin = getAdminCredentials();

  if (email === admin.email && password === admin.password) {
    delete req.session.storeManagerUserId;
    req.session.isAdmin = true;
    res.redirect("/admin/orders");
    return;
  }

  res.status(401).render("admin-login", { error: "Invalid admin email or password." });
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
});

app.get("/admin/orders", requireStoreOperator, async (req, res) => {
  try {
    await renderOperatorDashboard(req, res);
  } catch (error) {
    console.error("Admin dashboard failed to load:", error);
    const fallbackMessage = error && error.message
      ? `Admin dashboard failed to load: ${error.message}`
      : "Admin dashboard failed to load.";
    res.redirect(`/admin/login?error=${encodeURIComponent(fallbackMessage)}`);
  }
});

app.post("/admin/smtp/settings", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    if (String(req.body.clearSaved || "") === "1") {
      saveSmtpSettings({}, storeId);
      res.redirect(buildOperatorRedirect(req, {
        message: "Saved SMTP settings were reset.",
        storeId,
      }));
      return;
    }

    const current = getSmtpSettings(storeId);
    const host = String(req.body.smtpHost || "").trim();
    const portText = String(req.body.smtpPort || "").trim();
    const user = String(req.body.smtpUser || "").trim();
    const passInput = String(req.body.smtpPass || "").trim();
    const fromEmail = String(req.body.fromEmail || "").trim();
    const fromName = String(req.body.fromName || "").trim();
    const secure = parseTriStateBoolean(req.body.smtpSecure);
    const rejectUnauthorized = parseTriStateBoolean(req.body.smtpRejectUnauthorized);

    let port = null;
    if (portText) {
      port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("SMTP port must be a valid number between 1 and 65535.");
      }
    }

    if (fromEmail && !isValidEmail(fromEmail)) {
      throw new Error("Please enter a valid FROM email address.");
    }

    const pass = passInput || current.pass || "";

    saveSmtpSettings({
      host,
      port,
      secure,
      user,
      pass,
      fromEmail,
      fromName,
      rejectUnauthorized,
    }, storeId);

    res.redirect(buildOperatorRedirect(req, {
      message: "SMTP settings saved.",
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "Failed to save SMTP settings.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/smtp/test", requireStoreOperator, async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const toEmail = String(req.body.testEmail || req.body.newOrderEmail || "").trim().toLowerCase();
    if (!toEmail) {
      throw new Error("Enter a recipient email for SMTP test.");
    }

    await verifySmtpConnection();
    await sendSmtpTestEmail(toEmail);
    res.redirect(buildOperatorRedirect(req, {
      message: `SMTP test email sent to ${toEmail}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "SMTP test failed.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/notifications/settings", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const enabled = String(req.body.enabled || "") === "1";
    const newOrderEmail = String(req.body.newOrderEmail || "").trim().toLowerCase();

    if (enabled && !newOrderEmail) {
      throw new Error("Notification email is required when admin order notifications are enabled.");
    }

    if (newOrderEmail && !isValidEmail(newOrderEmail)) {
      throw new Error("Please enter a valid notification email address.");
    }

    saveAdminNotificationSettings({
      enabled,
      newOrderEmail,
    }, storeId);

    res.redirect(buildOperatorRedirect(req, {
      message: "Admin notification settings saved.",
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "Failed to save admin notification settings.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.get("/admin/facebook-autopost/settings", requireStoreOperator, (req, res) => {
  res.redirect(buildOperatorRedirect(req, {
    tab: "facebook",
    storeId: getOperatorStoreId(req),
  }));
});

app.post("/admin/facebook-autopost/settings", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const existing = getFacebookAutoPostConfig(storeId);
    const enabled = String(req.body.enabled || "") === "1";
    const appIdInput = String(req.body.appId || "").trim();
    const appSecretInput = String(req.body.appSecret || "").trim();
    const loginRedirectUriInput = String(req.body.loginRedirectUri || "").trim();
    const userAccessTokenInput = normalizeFacebookToken(req.body.userAccessToken);
    const selectedPageIdInput = String(req.body.selectedPageId || "").trim();
    const pageIdInput = String(req.body.pageId || "").trim();
    const tokenInput = normalizeFacebookToken(req.body.pageAccessToken);
    const baseUrlInput = String(req.body.baseUrl || "").trim();
    const timezoneInput = String(req.body.timezone || "").trim();
    const parsedTime = parseTimeInput(req.body.postTime, existing.hour, existing.minute);
    const itemsPerPost = clampItemsPerPost(req.body.itemsPerPost);
    const selectedPage = getSelectedFacebookPage(existing, selectedPageIdInput || existing.selectedPageId);

    const nextConfig = {
      ...existing,
      enabled,
      appId: appIdInput || existing.appId,
      appSecret: appSecretInput || existing.appSecret,
      loginRedirectUri: loginRedirectUriInput || existing.loginRedirectUri || getFacebookConnectRedirectUri(req, existing),
      userAccessToken: userAccessTokenInput || existing.userAccessToken,
      selectedPageId: selectedPageIdInput || existing.selectedPageId,
      pageId: pageIdInput || existing.pageId,
      pageName: selectedPage ? selectedPage.name : existing.pageName,
      pageAccessToken: tokenInput || (selectedPage ? selectedPage.accessToken : existing.pageAccessToken),
      baseUrl: baseUrlInput || existing.baseUrl || toBaseUrlFromRequest(req),
      timezone: timezoneInput || existing.timezone || "Asia/Manila",
      hour: parsedTime.hour,
      minute: parsedTime.minute,
      itemsPerPost,
    };

    if (selectedPage && !pageIdInput) {
      nextConfig.pageId = selectedPage.id;
      nextConfig.pageName = selectedPage.name;
    }

    if (enabled && !nextConfig.pageId) {
      throw new Error("Facebook Page ID is required when auto-post is enabled.");
    }

    if (enabled && !nextConfig.pageAccessToken) {
      throw new Error("Facebook Page access token is required when auto-post is enabled.");
    }

    if (enabled && !looksLikeFacebookAccessToken(nextConfig.pageAccessToken)) {
      throw new Error(
        "Facebook token format looks invalid. Paste a real Page Access Token (usually starts with EA and is much longer)."
      );
    }

    saveFacebookAutoPostConfig(nextConfig, storeId);
    rescheduleFacebookAutoPost();

    res.redirect(buildOperatorRedirect(req, {
      tab: "facebook",
      message: "Facebook auto-post settings saved.",
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "facebook",
      error: error.message || "Failed to save Facebook auto-post settings.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.get("/admin/facebook/connect", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const config = getFacebookAutoPostConfig(storeId);
    if (!String(config.appSecret || "").trim()) {
      throw new Error("Save your Facebook App Secret first before starting Facebook login.");
    }

    const nextConfig = {
      ...config,
      loginRedirectUri: getFacebookConnectRedirectUri(req, config),
    };
    saveFacebookAutoPostConfig(nextConfig, storeId);
    res.redirect(buildFacebookLoginUrl(req, nextConfig));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "facebook",
      error: error.message || "Failed to start Facebook login.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.get("/admin/facebook/connect/callback", requireStoreOperator, async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const config = getFacebookAutoPostConfig(storeId);
    if (String(req.query.error || "").trim()) {
      throw new Error(String(req.query.error_description || req.query.error || "Facebook login was cancelled."));
    }

    const code = String(req.query.code || "").trim();
    if (!code) {
      throw new Error("Facebook did not return an authorization code.");
    }

    const appId = String(config.appId || "").trim();
    const appSecret = String(config.appSecret || "").trim();
    const redirectUri = getFacebookConnectRedirectUri(req, config);
    if (!appId || !appSecret) {
      throw new Error("Facebook App ID and App Secret are required to finish Facebook login.");
    }

    const tokenParams = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    });

    const tokenResponse = await fetch(`https://graph.facebook.com/v20.0/oauth/access_token?${tokenParams.toString()}`);
    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
      throw new Error(
        String((tokenData && tokenData.error && tokenData.error.message) || "Failed to exchange Facebook login code.")
      );
    }

    const userAccessToken = normalizeFacebookToken(tokenData.access_token);
    const pages = await fetchFacebookPages(userAccessToken);
    const selectedPage = pages[0] || null;

    saveFacebookAutoPostConfig({
      ...config,
      loginRedirectUri: redirectUri,
      userAccessToken,
      availablePages: pages,
      selectedPageId: selectedPage ? selectedPage.id : "",
      pageId: selectedPage ? selectedPage.id : config.pageId,
      pageName: selectedPage ? selectedPage.name : config.pageName,
      pageAccessToken: selectedPage ? selectedPage.accessToken : config.pageAccessToken,
    }, storeId);

    res.redirect(buildOperatorRedirect(req, {
      tab: "facebook",
      message: `Facebook connected. ${pages.length} page(s) loaded.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "facebook",
      error: error.message || "Failed to complete Facebook login.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/facebook/pages/sync", requireStoreOperator, async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const existing = getFacebookAutoPostConfig(storeId);
    const userAccessToken = normalizeFacebookToken(req.body.userAccessToken || existing.userAccessToken);
    if (!userAccessToken) {
      throw new Error("Facebook user access token is required to load pages.");
    }

    const pages = await fetchFacebookPages(userAccessToken);
    const selectedPageId = String(existing.selectedPageId || "").trim();
    const selectedPage =
      pages.find((page) => page.id === selectedPageId) ||
      pages.find((page) => page.id === String(existing.pageId || "").trim()) ||
      pages[0] ||
      null;

    saveFacebookAutoPostConfig({
      ...existing,
      userAccessToken,
      availablePages: pages,
      selectedPageId: selectedPage ? selectedPage.id : "",
      pageId: selectedPage ? selectedPage.id : existing.pageId,
      pageName: selectedPage ? selectedPage.name : existing.pageName,
      pageAccessToken: selectedPage ? selectedPage.accessToken : existing.pageAccessToken,
    }, storeId);

    res.redirect(buildOperatorRedirect(req, {
      tab: "facebook",
      message: `Loaded ${pages.length} Facebook page(s).`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "facebook",
      error: error.message || "Failed to load Facebook pages.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/items/:id/paymongo-link", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const itemId = String(req.params.id || "");
    const paymongoLink = String(req.body.paymongoLink || "").trim();

    if (paymongoLink && !isValidHttpUrl(paymongoLink)) {
      throw new Error("PayMongo link must be a valid http/https URL.");
    }

    const item = updateItemPaymongoLink(itemId, paymongoLink, storeId);
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      message: `PayMongo link saved for ${item.name}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      error: error.message || "Failed to save PayMongo link.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/paymongo/amount-links", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const amount = Number(req.body.amount);
    const paymongoLink = String(req.body.paymongoLink || "").trim();
    const step = getPaymongoCheckoutLinks(storeId).step;

    if (!Number.isInteger(amount) || amount < step || amount % step !== 0) {
      throw new Error(`Amount must be a multiple of PHP ${step}.`);
    }

    if (!isValidHttpUrl(paymongoLink)) {
      throw new Error("PayMongo link must be a valid http/https URL.");
    }

    savePaymongoAmountLink(amount, paymongoLink, storeId);
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      message: `Checkout PayMongo link saved for PHP ${amount}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      error: error.message || "Failed to save checkout PayMongo link.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/paymongo/amount-links/bulk", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const step = getPaymongoCheckoutLinks(storeId).step;
    const maxAmount = 1000;

    for (let amount = step; amount <= maxAmount; amount += step) {
      const fieldKey = `amount_${amount}`;
      const paymongoLink = String(req.body[fieldKey] || "").trim();

      if (!paymongoLink) {
        deletePaymongoAmountLink(amount, storeId);
        continue;
      }

      if (!isValidHttpUrl(paymongoLink)) {
        throw new Error(`PayMongo link for PHP ${amount} must be a valid http/https URL.`);
      }

      savePaymongoAmountLink(amount, paymongoLink, storeId);
    }

    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      message: "Checkout PayMongo links saved for PHP 50 to PHP 1,000.",
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      error: error.message || "Failed to save checkout PayMongo links.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/paymongo/amount-links/:amount/delete", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const amount = Number(req.params.amount);
    deletePaymongoAmountLink(amount, storeId);
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      message: `Checkout PayMongo link removed for PHP ${amount}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      error: error.message || "Failed to remove checkout PayMongo link.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/items/create", requireStoreOperator, upload.single("productImage"), async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const item = createItem({
      storeId,
      name: req.body.name,
      category: req.body.category,
      price: req.body.price,
      stock: req.body.stock,
      description: req.body.description,
      imageUrl: await resolveItemImageInput({
        file: req.file,
        imageUrl: req.body.imageUrl,
        imageProcessMode: req.body.imageProcessMode,
      }),
      paymongoLink: req.body.paymongoLink,
    });

    res.redirect(buildOperatorRedirect(req, {
      tab: "inventory",
      message: `Item ${item.id} created.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "inventory",
      error: error.message || "Failed to create item.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/items/:id/inventory", requireStoreOperator, upload.single("productImage"), async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const itemId = String(req.params.id || "");
    const item = updateItemInventory(itemId, {
      storeId,
      name: req.body.name,
      category: req.body.category,
      price: req.body.price,
      stock: req.body.stock,
      description: req.body.description,
      imageUrl: await resolveItemImageInput({
        file: req.file,
        imageUrl: req.body.imageUrl,
        fallbackImageUrl: req.body.currentImageUrl,
        imageProcessMode: req.body.imageProcessMode,
      }),
    });

    res.redirect(buildOperatorRedirect(req, {
      tab: "inventory",
      message: `Inventory updated for ${item.id}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "inventory",
      error: error.message || "Failed to update inventory.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/items/:id/block", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const itemId = String(req.params.id || "");
    const blocked = String(req.body.blocked || "") === "1";
    const item = setItemBlocked(itemId, blocked, storeId);
    const actionLabel = item.isBlocked ? "blocked" : "unblocked";

    res.redirect(buildOperatorRedirect(req, {
      tab: "inventory",
      message: `${item.id} is now ${actionLabel}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "inventory",
      error: error.message || "Failed to update block status.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/items/:id/name", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const itemId = String(req.params.id || "");
    const name = String(req.body.name || "").trim();
    const item = updateItemName(itemId, name, storeId);

    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      message: `Product name updated for ${item.id}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      error: error.message || "Failed to update product name.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/items/:id/ai-name", requireStoreOperator, upload.single("aiProductImage"), async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const itemId = String(req.params.id || "");
    const items = getItems(storeId);
    const item = items.find((entry) => entry.id === itemId);

    if (!item) {
      throw new Error("Item not found.");
    }

    if (!req.file) {
      throw new Error("Upload an image first.");
    }

    if (!String(req.file.mimetype || "").startsWith("image/")) {
      throw new Error("Uploaded file must be an image.");
    }

    const suggestion = await suggestProductNameFromImage({
      imageBase64: req.file.buffer.toString("base64"),
      mimeType: req.file.mimetype,
      category: item.category,
      currentName: item.name,
    });
    const updatedItem = updateItemName(itemId, suggestion, storeId);

    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      message: `AI generated name for ${updatedItem.id}: ${updatedItem.name}`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "links",
      error: error.message || "Failed to generate product name from image.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/facebook-autopost/run", requireStoreOperator, async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    await runFacebookAutoPost("manual", storeId);
    res.redirect(buildOperatorRedirect(req, {
      message: "Posted random items to Facebook.",
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "Facebook post failed.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/orders/:id/approve", requireStoreOperator, async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const order = approveOrder(req.params.id, storeId);

    try {
      const sent = await sendApprovedOrderEmail(order);
      if (sent) {
        markOrderEmailNotified(order.id, storeId);
      }
    } catch (mailError) {
      console.error("Failed to send approval email:", mailError.message);
    }

    res.redirect(buildOperatorRedirect(req, {
      message: `Order #${order.id} approved.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "Failed to approve order.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/orders/:id/status", requireStoreOperator, async (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const nextStatus = String(req.body.nextStatus || "").toUpperCase();
    const order = updateOrderStatus(req.params.id, nextStatus, storeId);

    try {
      let sent = false;
      if (nextStatus === ORDER_STATUSES.PAID) {
        sent = await sendApprovedOrderEmail(order);
        if (sent) {
          markOrderEmailNotified(order.id, storeId);
        }
      } else {
        await sendOrderStatusUpdateEmail(order);
      }
    } catch (mailError) {
      console.error("Failed to send status email:", mailError.message);
    }

    const label = formatOrderStatus(order.status);
    res.redirect(buildOperatorRedirect(req, {
      message: `Order #${order.id} updated to ${label}.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "Failed to update order status.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/orders/:id/archive", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const order = archiveOrder(req.params.id, storeId);
    res.redirect(buildOperatorRedirect(req, {
      message: `Order #${order.id} archived.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "Failed to archive order.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/orders/:id/unarchive", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const order = unarchiveOrder(req.params.id, storeId);
    res.redirect(buildOperatorRedirect(req, {
      message: `Order #${order.id} moved back to active.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      error: error.message || "Failed to unarchive order.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/orders/:id/delete", requireStoreOperator, (req, res) => {
  try {
    const storeId = getOperatorStoreId(req);
    const order = deleteOrder(req.params.id, storeId);
    res.redirect(buildOperatorRedirect(req, {
      message: `Order #${order.id} deleted permanently.`,
      tab: "archived",
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "archived",
      error: error.message || "Failed to delete order.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/stores/create", requireAdmin, (req, res) => {
  try {
    const store = createStore({
      name: req.body.name,
      slug: req.body.slug,
      description: req.body.description,
      subscriptionPlan: req.body.subscriptionPlan,
      subscriptionStatus: req.body.subscriptionStatus,
    });
    if (req.session) {
      req.session.activeAdminStoreId = store.id;
    }
    res.redirect(buildOperatorRedirect(req, {
      tab: "stores",
      message: `Store ${store.name} created.`,
      storeId: store.id,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "stores",
      error: error.message || "Failed to create store.",
      storeId: getOperatorStoreId(req),
    }));
  }
});

app.post("/admin/store-managers/create", requireAdmin, (req, res) => {
  try {
    const storeId = Number(req.body.storeId || getOperatorStoreId(req));
    const manager = createStoreManager({
      storeId,
      fullName: req.body.fullName,
      email: req.body.email,
      password: req.body.password,
    });
    res.redirect(buildOperatorRedirect(req, {
      tab: "stores",
      message: `Store manager ${manager.fullName || manager.email} created.`,
      storeId,
    }));
  } catch (error) {
    res.redirect(buildOperatorRedirect(req, {
      tab: "stores",
      error: error.message || "Failed to create store manager.",
      storeId: Number(req.body.storeId || getOperatorStoreId(req)),
    }));
  }
});

rescheduleFacebookAutoPost();
startPendingReminderCron();

app.listen(port, host, () => {
  console.log(`Preloved app running at http://${publicHostLabel}:${port}`);
});
