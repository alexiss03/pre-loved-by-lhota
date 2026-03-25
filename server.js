require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");

const {
  DELIVERY_FEES,
  CHECKOUT_MODES,
  ORDER_STATUSES,
  DEFAULT_FACEBOOK_AUTO_POST,
  ITEM_CATEGORIES,
  ensureDataFile,
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
const { postRandomItemsToFacebook } = require("./utils/facebookPoster");

const app = express();
const port = Number(process.env.PORT) || 3000;
const host = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const publicHostLabel = host === "0.0.0.0" ? "localhost" : host;
const UNPROCESSED_ORDER_REMINDER_HOURS = Number(process.env.UNPROCESSED_ORDER_REMINDER_HOURS) > 0
  ? Number(process.env.UNPROCESSED_ORDER_REMINDER_HOURS)
  : 24;

ensureDataFile();

const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadsDir);
  },
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname);
    const safeExt = extension || ".jpg";
    callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  },
});

const upload = multer({
  storage,
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

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    next();
    return;
  }

  res.redirect("/admin/login");
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

  const imagePath = String((payload && payload.imagePath) || "").trim();
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error("Uploaded image file was not found.");
  }

  const mimeType = String((payload && payload.mimeType) || "").trim() || inferMimeTypeFromFilename(imagePath);
  if (!mimeType.startsWith("image/")) {
    throw new Error("Uploaded file must be a valid image.");
  }

  const imageBase64 = fs.readFileSync(imagePath, "base64");
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

async function sendPendingOrderReminders(orders) {
  const notificationSettings = getAdminNotificationSettings();
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
        markOrderPendingReminderNotified(order.id);
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
  const orders = getOrders();
  return sendPendingOrderReminders(orders);
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

async function runFacebookAutoPost(triggeredBy = "cron") {
  const config = getFacebookAutoPostConfig();

  if (!config.enabled && triggeredBy === "cron") {
    return { skipped: true, message: "Auto-post is disabled." };
  }

  try {
    const items = getPublicItems(getItems());
    const result = await postRandomItemsToFacebook(config, items);
    setFacebookAutoPostLastResult({
      status: "SUCCESS",
      message: `Posted ${result.pickedItems.length} random item(s) to Facebook.`,
      postId: result.postId,
      postedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      triggeredBy,
    });

    return { skipped: false, message: "Facebook auto-post completed.", ...result };
  } catch (error) {
    setFacebookAutoPostLastResult({
      status: "ERROR",
      message: error.message || "Facebook auto-post failed.",
      attemptedAt: new Date().toISOString(),
      triggeredBy,
    });
    throw error;
  }
}

function rescheduleFacebookAutoPost() {
  if (facebookAutoPostTask) {
    facebookAutoPostTask.stop();
    facebookAutoPostTask.destroy();
    facebookAutoPostTask = null;
  }

  const config = getFacebookAutoPostConfig();
  if (!config.enabled) {
    return config;
  }

  const expression = `${config.minute} ${config.hour} * * *`;
  try {
    facebookAutoPostTask = cron.schedule(
      expression,
      async () => {
        try {
          await runFacebookAutoPost("cron");
        } catch (error) {
          console.error("Facebook cron post failed:", error.message);
        }
      },
      { timezone: config.timezone || "Asia/Manila" }
    );
  } catch (error) {
    console.error("Failed to schedule Facebook auto-post cron:", error.message);
    setFacebookAutoPostLastResult({
      status: "ERROR",
      message: `Invalid cron settings: ${error.message}`,
      attemptedAt: new Date().toISOString(),
      triggeredBy: "scheduler",
    });
  }

  return config;
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

app.get("/", (_req, res) => {
  const items = getPublicItems(getItems());
  res.render("index", { items });
});

app.get("/signup", (req, res) => {
  if (res.locals.buyerUser) {
    res.redirect("/");
    return;
  }

  res.render("user-signup", {
    error: "",
    form: {
      fullName: "",
      email: "",
      phone: "",
    },
  });
});

app.post("/signup", (req, res) => {
  try {
    if (res.locals.buyerUser) {
      res.redirect("/");
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
    res.redirect("/");
  } catch (error) {
    res.status(400).render("user-signup", {
      error: error.message || "Failed to sign up.",
      form: {
        fullName: String(req.body.fullName || "").trim(),
        email: String(req.body.email || "").trim(),
        phone: String(req.body.phone || "").trim(),
      },
    });
  }
});

app.get("/login", (req, res) => {
  if (res.locals.buyerUser) {
    res.redirect("/");
    return;
  }

  res.render("user-login", {
    error: "",
    message: String(req.query.message || ""),
    email: "",
    redirectTo: toSafeRedirectPath(req.query.redirectTo, "/"),
  });
});

app.post("/login", (req, res) => {
  try {
    if (res.locals.buyerUser) {
      res.redirect("/");
      return;
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const redirectTo = toSafeRedirectPath(req.body.redirectTo, "/");

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
    res.status(401).render("user-login", {
      error: error.message || "Login failed.",
      message: "",
      email: String(req.body.email || "").trim(),
      redirectTo: toSafeRedirectPath(req.body.redirectTo, "/"),
    });
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
  const items = getPublicItems(getItems());
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

  res.render("shop", {
    items: filteredItems,
    allItemsJson: JSON.stringify(items),
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
  });
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
  const itemId = String(req.params.itemId || "");
  const items = getPublicItems(getItems());
  const item = items.find((entry) => entry.id === itemId);

  if (!item) {
    res.redirect("/shop");
    return;
  }

  const relatedItems = items
    .filter((entry) => entry.id !== item.id && entry.category === item.category)
    .slice(0, 4);

  res.render("product-detail", {
    item,
    relatedItems,
    baseUrl: process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`,
    error: String(req.query.error || ""),
    allItemsJson: JSON.stringify(items),
  });
});

app.get("/payment/waiting/:itemId", (req, res) => {
  const itemId = String(req.params.itemId || "");
  const items = getPublicItems(getItems());
  const item = items.find((entry) => entry.id === itemId);

  if (!item) {
    res.redirect("/shop");
    return;
  }

  if (!item.paymongoLink) {
    res.redirect(`/product/${encodeURIComponent(item.id)}?error=${encodeURIComponent("PayMongo link is not configured for this product yet.")}`);
    return;
  }

  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const callbackUrl = `${baseUrl}/payment/callback?itemId=${encodeURIComponent(item.id)}`;
  res.render("payment-waiting", {
    item,
    callbackUrl,
  });
});

app.get("/payment/callback", (req, res) => {
  const itemId = String(req.query.itemId || "").trim();
  const status = String(req.query.status || "pending").trim().toUpperCase();
  const items = getPublicItems(getItems());
  const item = items.find((entry) => entry.id === itemId) || null;
  const statusLabelMap = {
    PAID: "Paid",
    SUCCESS: "Paid",
    FAILED: "Failed",
    CANCELLED: "Cancelled",
    PENDING: "Pending",
  };
  const statusLabel = statusLabelMap[status] || "Pending";

  res.render("payment-callback", {
    item,
    status,
    statusLabel,
  });
});

app.get("/cart", (req, res) => {
  const items = getPublicItems(getItems());
  const paymongoCheckout = getPaymongoCheckoutLinks();
  res.render("cart", {
    items,
    itemsJson: JSON.stringify(items),
    deliveryFees: DELIVERY_FEES,
    paymongoCheckout,
    error: req.query.error || "",
    buyerUser: res.locals.buyerUser || null,
  });
});

app.get("/buy/:itemId", (req, res) => {
  const itemId = String(req.params.itemId || "");
  const items = getPublicItems(getItems());
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
  const items = getPublicItems(getItems());

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

    const order = createOrder({
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
      paymentProofPath: `/uploads/${req.file.filename}`,
      items: sanitizedItems,
    });

    let pendingEmailSent = false;
    try {
      pendingEmailSent = await sendPendingOrderEmail(order);
    } catch (mailError) {
      console.error("Failed to send pending order email:", mailError.message);
    }

    try {
      const notificationSettings = getAdminNotificationSettings();
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
    });
  } catch (error) {
    const paymongoCheckout = getPaymongoCheckoutLinks();
    res.status(400).render("cart", {
      items,
      itemsJson: JSON.stringify(items),
      deliveryFees: DELIVERY_FEES,
      paymongoCheckout,
      error: error.message || "Failed to submit order.",
      buyerUser: res.locals.buyerUser || null,
    });
  }
});

app.get("/admin/login", (req, res) => {
  if (req.session && req.session.isAdmin) {
    res.redirect("/admin/orders");
    return;
  }

  res.render("admin-login", { error: "" });
});

app.post("/admin/login", (req, res) => {
  const { email, password } = req.body;
  const admin = getAdminCredentials();

  if (email === admin.email && password === admin.password) {
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

app.get("/admin/orders", requireAdmin, async (req, res) => {
  const orders = getOrders();
  const items = getItems();
  const inventoryItems = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const paymongoCheckout = getPaymongoCheckoutLinks();
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const adminNotifications = getAdminNotificationSettings();
  const smtpSettings = getSmtpSettings();
  const facebookAutoPost = getFacebookAutoPostConfig();
  const smtpStatus = getSmtpConfigStatus();

  try {
    await sendPendingOrderReminders(orders);
  } catch (error) {
    console.error("Pending reminder scan failed:", error.message);
  }

  const activeOrders = orders.filter((order) => !order.isArchived);
  const archivedOrders = orders.filter((order) => order.isArchived);
  const pendingOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.PENDING);
  const paidOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.PAID);
  const forDeliveryOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.FOR_DELIVERY);
  const receivedOrders = activeOrders.filter((order) => order.status === ORDER_STATUSES.RECEIVED);

  res.render("admin-orders", {
    items,
    inventoryItems,
    inventoryCategories: Object.values(ITEM_CATEGORIES),
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
  });
});

app.post("/admin/smtp/settings", requireAdmin, (req, res) => {
  try {
    if (String(req.body.clearSaved || "") === "1") {
      saveSmtpSettings({});
      res.redirect("/admin/orders?message=" + encodeURIComponent("Saved SMTP settings were reset."));
      return;
    }

    const current = getSmtpSettings();
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
    });

    res.redirect("/admin/orders?message=" + encodeURIComponent("SMTP settings saved."));
  } catch (error) {
    res.redirect(
      "/admin/orders?error=" + encodeURIComponent(error.message || "Failed to save SMTP settings.")
    );
  }
});

app.post("/admin/smtp/test", requireAdmin, async (req, res) => {
  try {
    const toEmail = String(req.body.testEmail || req.body.newOrderEmail || "").trim().toLowerCase();
    if (!toEmail) {
      throw new Error("Enter a recipient email for SMTP test.");
    }

    await verifySmtpConnection();
    await sendSmtpTestEmail(toEmail);
    res.redirect("/admin/orders?message=" + encodeURIComponent(`SMTP test email sent to ${toEmail}.`));
  } catch (error) {
    res.redirect("/admin/orders?error=" + encodeURIComponent(error.message || "SMTP test failed."));
  }
});

app.post("/admin/notifications/settings", requireAdmin, (req, res) => {
  try {
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
    });

    res.redirect("/admin/orders?message=" + encodeURIComponent("Admin notification settings saved."));
  } catch (error) {
    res.redirect(
      "/admin/orders?error=" +
        encodeURIComponent(error.message || "Failed to save admin notification settings.")
    );
  }
});

app.get("/admin/facebook-autopost/settings", requireAdmin, (_req, res) => {
  res.redirect("/admin/orders?tab=facebook");
});

app.post("/admin/facebook-autopost/settings", requireAdmin, (req, res) => {
  try {
    const existing = getFacebookAutoPostConfig();
    const enabled = String(req.body.enabled || "") === "1";
    const pageIdInput = String(req.body.pageId || "").trim();
    const tokenInput = normalizeFacebookToken(req.body.pageAccessToken);
    const baseUrlInput = String(req.body.baseUrl || "").trim();
    const timezoneInput = String(req.body.timezone || "").trim();
    const parsedTime = parseTimeInput(req.body.postTime, existing.hour, existing.minute);
    const itemsPerPost = clampItemsPerPost(req.body.itemsPerPost);

    const nextConfig = {
      ...existing,
      enabled,
      pageId: pageIdInput || existing.pageId,
      pageAccessToken: tokenInput || existing.pageAccessToken,
      baseUrl: baseUrlInput || existing.baseUrl || toBaseUrlFromRequest(req),
      timezone: timezoneInput || existing.timezone || "Asia/Manila",
      hour: parsedTime.hour,
      minute: parsedTime.minute,
      itemsPerPost,
    };

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

    saveFacebookAutoPostConfig(nextConfig);
    rescheduleFacebookAutoPost();

    res.redirect("/admin/orders?message=" + encodeURIComponent("Facebook auto-post settings saved."));
  } catch (error) {
    res.redirect(
      "/admin/orders?error=" +
        encodeURIComponent(error.message || "Failed to save Facebook auto-post settings.")
    );
  }
});

app.post("/admin/items/:id/paymongo-link", requireAdmin, (req, res) => {
  try {
    const itemId = String(req.params.id || "");
    const paymongoLink = String(req.body.paymongoLink || "").trim();

    if (paymongoLink && !isValidHttpUrl(paymongoLink)) {
      throw new Error("PayMongo link must be a valid http/https URL.");
    }

    const item = updateItemPaymongoLink(itemId, paymongoLink);
    res.redirect(
      "/admin/orders?tab=links&message=" +
        encodeURIComponent(`PayMongo link saved for ${item.name}.`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=links&error=" +
        encodeURIComponent(error.message || "Failed to save PayMongo link.")
    );
  }
});

app.post("/admin/paymongo/amount-links", requireAdmin, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const paymongoLink = String(req.body.paymongoLink || "").trim();
    const step = getPaymongoCheckoutLinks().step;

    if (!Number.isInteger(amount) || amount < step || amount % step !== 0) {
      throw new Error(`Amount must be a multiple of PHP ${step}.`);
    }

    if (!isValidHttpUrl(paymongoLink)) {
      throw new Error("PayMongo link must be a valid http/https URL.");
    }

    savePaymongoAmountLink(amount, paymongoLink);
    res.redirect(
      "/admin/orders?tab=links&message=" +
        encodeURIComponent(`Checkout PayMongo link saved for PHP ${amount}.`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=links&error=" +
        encodeURIComponent(error.message || "Failed to save checkout PayMongo link.")
    );
  }
});

app.post("/admin/paymongo/amount-links/bulk", requireAdmin, (req, res) => {
  try {
    const step = getPaymongoCheckoutLinks().step;
    const maxAmount = 1000;

    for (let amount = step; amount <= maxAmount; amount += step) {
      const fieldKey = `amount_${amount}`;
      const paymongoLink = String(req.body[fieldKey] || "").trim();

      if (!paymongoLink) {
        deletePaymongoAmountLink(amount);
        continue;
      }

      if (!isValidHttpUrl(paymongoLink)) {
        throw new Error(`PayMongo link for PHP ${amount} must be a valid http/https URL.`);
      }

      savePaymongoAmountLink(amount, paymongoLink);
    }

    res.redirect(
      "/admin/orders?tab=links&message=" +
        encodeURIComponent("Checkout PayMongo links saved for PHP 50 to PHP 1,000.")
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=links&error=" +
        encodeURIComponent(error.message || "Failed to save checkout PayMongo links.")
    );
  }
});

app.post("/admin/paymongo/amount-links/:amount/delete", requireAdmin, (req, res) => {
  try {
    const amount = Number(req.params.amount);
    deletePaymongoAmountLink(amount);
    res.redirect(
      "/admin/orders?tab=links&message=" +
        encodeURIComponent(`Checkout PayMongo link removed for PHP ${amount}.`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=links&error=" +
        encodeURIComponent(error.message || "Failed to remove checkout PayMongo link.")
    );
  }
});

app.post("/admin/items/create", requireAdmin, (req, res) => {
  try {
    const item = createItem({
      name: req.body.name,
      category: req.body.category,
      price: req.body.price,
      stock: req.body.stock,
      description: req.body.description,
      imageUrl: req.body.imageUrl,
      paymongoLink: req.body.paymongoLink,
    });

    res.redirect(
      "/admin/orders?tab=inventory&message=" +
        encodeURIComponent(`Item ${item.id} created.`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=inventory&error=" +
        encodeURIComponent(error.message || "Failed to create item.")
    );
  }
});

app.post("/admin/items/:id/inventory", requireAdmin, (req, res) => {
  try {
    const itemId = String(req.params.id || "");
    const item = updateItemInventory(itemId, {
      name: req.body.name,
      category: req.body.category,
      price: req.body.price,
      stock: req.body.stock,
      description: req.body.description,
      imageUrl: req.body.imageUrl,
    });

    res.redirect(
      "/admin/orders?tab=inventory&message=" +
        encodeURIComponent(`Inventory updated for ${item.id}.`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=inventory&error=" +
        encodeURIComponent(error.message || "Failed to update inventory.")
    );
  }
});

app.post("/admin/items/:id/block", requireAdmin, (req, res) => {
  try {
    const itemId = String(req.params.id || "");
    const blocked = String(req.body.blocked || "") === "1";
    const item = setItemBlocked(itemId, blocked);
    const actionLabel = item.isBlocked ? "blocked" : "unblocked";

    res.redirect(
      "/admin/orders?tab=inventory&message=" +
        encodeURIComponent(`${item.id} is now ${actionLabel}.`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=inventory&error=" +
        encodeURIComponent(error.message || "Failed to update block status.")
    );
  }
});

app.post("/admin/items/:id/name", requireAdmin, (req, res) => {
  try {
    const itemId = String(req.params.id || "");
    const name = String(req.body.name || "").trim();
    const item = updateItemName(itemId, name);

    res.redirect(
      "/admin/orders?tab=links&message=" +
        encodeURIComponent(`Product name updated for ${item.id}.`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=links&error=" +
        encodeURIComponent(error.message || "Failed to update product name.")
    );
  }
});

app.post("/admin/items/:id/ai-name", requireAdmin, upload.single("aiProductImage"), async (req, res) => {
  let uploadedImagePath = "";

  try {
    const itemId = String(req.params.id || "");
    const items = getItems();
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

    uploadedImagePath = String(req.file.path || "");
    const suggestion = await suggestProductNameFromImage({
      imagePath: uploadedImagePath,
      mimeType: req.file.mimetype,
      category: item.category,
      currentName: item.name,
    });
    const updatedItem = updateItemName(itemId, suggestion);

    res.redirect(
      "/admin/orders?tab=links&message=" +
        encodeURIComponent(`AI generated name for ${updatedItem.id}: ${updatedItem.name}`)
    );
  } catch (error) {
    res.redirect(
      "/admin/orders?tab=links&error=" +
        encodeURIComponent(error.message || "Failed to generate product name from image.")
    );
  } finally {
    if (uploadedImagePath && fs.existsSync(uploadedImagePath)) {
      try {
        fs.unlinkSync(uploadedImagePath);
      } catch (_cleanupError) {
        // ignore cleanup errors
      }
    }
  }
});

app.post("/admin/facebook-autopost/run", requireAdmin, async (_req, res) => {
  try {
    await runFacebookAutoPost("manual");
    res.redirect("/admin/orders?message=" + encodeURIComponent("Posted random items to Facebook."));
  } catch (error) {
    res.redirect(
      "/admin/orders?error=" +
        encodeURIComponent(error.message || "Facebook post failed.")
    );
  }
});

app.post("/admin/orders/:id/approve", requireAdmin, async (req, res) => {
  try {
    const order = approveOrder(req.params.id);

    try {
      const sent = await sendApprovedOrderEmail(order);
      if (sent) {
        markOrderEmailNotified(order.id);
      }
    } catch (mailError) {
      console.error("Failed to send approval email:", mailError.message);
    }

    res.redirect(`/admin/orders?message=${encodeURIComponent(`Order #${order.id} approved.`)}`);
  } catch (error) {
    res.redirect(`/admin/orders?error=${encodeURIComponent(error.message || "Failed to approve order.")}`);
  }
});

app.post("/admin/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const nextStatus = String(req.body.nextStatus || "").toUpperCase();
    const order = updateOrderStatus(req.params.id, nextStatus);

    try {
      let sent = false;
      if (nextStatus === ORDER_STATUSES.PAID) {
        sent = await sendApprovedOrderEmail(order);
        if (sent) {
          markOrderEmailNotified(order.id);
        }
      } else {
        await sendOrderStatusUpdateEmail(order);
      }
    } catch (mailError) {
      console.error("Failed to send status email:", mailError.message);
    }

    const label = formatOrderStatus(order.status);
    res.redirect(`/admin/orders?message=${encodeURIComponent(`Order #${order.id} updated to ${label}.`)}`);
  } catch (error) {
    res.redirect(`/admin/orders?error=${encodeURIComponent(error.message || "Failed to update order status.")}`);
  }
});

app.post("/admin/orders/:id/archive", requireAdmin, (req, res) => {
  try {
    const order = archiveOrder(req.params.id);
    res.redirect(`/admin/orders?message=${encodeURIComponent(`Order #${order.id} archived.`)}`);
  } catch (error) {
    res.redirect(`/admin/orders?error=${encodeURIComponent(error.message || "Failed to archive order.")}`);
  }
});

app.post("/admin/orders/:id/unarchive", requireAdmin, (req, res) => {
  try {
    const order = unarchiveOrder(req.params.id);
    res.redirect(`/admin/orders?message=${encodeURIComponent(`Order #${order.id} moved back to active.`)}`);
  } catch (error) {
    res.redirect(`/admin/orders?error=${encodeURIComponent(error.message || "Failed to unarchive order.")}`);
  }
});

app.post("/admin/orders/:id/delete", requireAdmin, (req, res) => {
  try {
    const order = deleteOrder(req.params.id);
    res.redirect(`/admin/orders?message=${encodeURIComponent(`Order #${order.id} deleted permanently.`)}`);
  } catch (error) {
    res.redirect(`/admin/orders?error=${encodeURIComponent(error.message || "Failed to delete order.")}`);
  }
});

rescheduleFacebookAutoPost();
startPendingReminderCron();

app.listen(port, host, () => {
  console.log(`Preloved app running at http://${publicHostLabel}:${port}`);
});
