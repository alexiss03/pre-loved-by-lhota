function pickRandomItems(items, count) {
  const pool = [...items];

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, Math.max(0, count));
}

function formatPrice(value) {
  return `PHP ${Number(value).toFixed(2)}`;
}

function sanitizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function toAbsoluteUrl(baseUrl, value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (/^https?:\/\//i.test(text)) {
    return text;
  }

  const normalizedBaseUrl = sanitizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return text;
  }

  return `${normalizedBaseUrl}${text.startsWith("/") ? text : `/${text}`}`;
}

function sanitizeAccessToken(value) {
  let token = String(value || "").trim();

  if (!token) {
    return "";
  }

  // Allow copy-paste from headers like: "Bearer EAAB..."
  token = token.replace(/^bearer\s+/i, "");

  // Remove wrapping quotes from accidental JSON/string copy.
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  // Remove line breaks/spaces from wrapped tokens.
  token = token.replace(/\s+/g, "");
  return token;
}

function looksLikeFacebookAccessToken(value) {
  const token = String(value || "").trim();
  return /^EA[A-Za-z0-9]/.test(token) && token.length >= 60;
}

function formatFacebookApiError(error, statusCode) {
  const message = String(error?.message || "").trim();
  const code = Number(error?.code);
  const subcode = Number(error?.error_subcode);

  if (code === 190 || /cannot parse access token/i.test(message)) {
    return [
      "Invalid Facebook access token.",
      "Use a valid Page Access Token (not App ID/secret, not a Bearer header).",
      "Paste only the raw token value in Admin > Facebook.",
    ].join(" ");
  }

  if (code === 10 || code === 200 || /permission/i.test(message)) {
    return [
      "Facebook token is valid but missing permissions.",
      "Grant pages_manage_posts and pages_read_engagement, then generate a new Page Access Token.",
    ].join(" ");
  }

  if (code === 803 || /unknown path components/i.test(message)) {
    return "Invalid Facebook Page ID. Check the Page ID in Admin settings.";
  }

  const details = [];
  if (Number.isFinite(code)) {
    details.push(`code ${code}`);
  }
  if (Number.isFinite(subcode)) {
    details.push(`subcode ${subcode}`);
  }
  if (Number.isFinite(statusCode)) {
    details.push(`HTTP ${statusCode}`);
  }

  if (details.length > 0) {
    return `${message || "Facebook API request failed."} (${details.join(", ")}).`;
  }

  return message || `Facebook API request failed (${statusCode || "unknown"}).`;
}

function buildPostMessage(items, baseUrl) {
  const lines = [
    "Fresh preloved picks from Pre-loved by Lhota:",
    "",
  ];

  items.forEach((item, index) => {
    const itemUrl = `${baseUrl}/product/${encodeURIComponent(item.id)}`;
    lines.push(`${index + 1}. ${item.name} (${item.category}) - ${formatPrice(item.price)}`);
    lines.push(itemUrl);
    lines.push("");
  });

  lines.push("Order now. Message us for availability.");
  return lines.join("\n");
}

async function uploadPhotoToFacebook({ pageId, accessToken, imageUrl }) {
  const payload = new URLSearchParams({
    url: imageUrl,
    published: "false",
    access_token: accessToken,
  });

  const response = await fetch(
    `https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}/photos`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(formatFacebookApiError(data?.error || {}, response.status));
  }

  return String(data.id || "").trim();
}

async function postRandomItemsToFacebook(config, allItems) {
  const pageId = String(config.pageId || "").trim();
  const accessToken = sanitizeAccessToken(config.pageAccessToken);
  const baseUrl = sanitizeBaseUrl(config.baseUrl);
  const itemsPerPost = Number(config.itemsPerPost) || 3;

  if (!pageId) {
    throw new Error("Facebook Page ID is required.");
  }

  if (!accessToken) {
    throw new Error("Facebook Page access token is required.");
  }

  if (!looksLikeFacebookAccessToken(accessToken)) {
    throw new Error(
      "Saved Facebook token format is invalid. Use a real Page Access Token (usually starts with EA and is much longer)."
    );
  }

  if (!baseUrl) {
    throw new Error("Base URL is required to generate product links.");
  }

  const availableItems = allItems.filter((item) => Number(item.stock) > 0);
  if (availableItems.length === 0) {
    throw new Error("No available items to post.");
  }

  const pickedItems = pickRandomItems(
    availableItems,
    Math.min(Math.max(1, itemsPerPost), availableItems.length)
  );

  const message = buildPostMessage(pickedItems, baseUrl);
  const uploadedPhotoIds = [];

  for (const item of pickedItems) {
    const imageUrl = toAbsoluteUrl(baseUrl, item && item.imageUrl);
    if (!imageUrl) {
      continue;
    }

    try {
      const mediaId = await uploadPhotoToFacebook({
        pageId,
        accessToken,
        imageUrl,
      });
      if (mediaId) {
        uploadedPhotoIds.push(mediaId);
      }
    } catch (error) {
      console.warn(`Skipping Facebook image upload for item ${item.id}: ${error.message}`);
    }
  }

  const payload = new URLSearchParams({
    message,
    access_token: accessToken,
  });

  if (uploadedPhotoIds.length > 0) {
    uploadedPhotoIds.forEach((mediaId, index) => {
      payload.append(`attached_media[${index}]`, JSON.stringify({ media_fbid: mediaId }));
    });
  } else {
    const firstItemUrl = `${baseUrl}/product/${encodeURIComponent(pickedItems[0].id)}`;
    payload.set("link", firstItemUrl);
  }

  const response = await fetch(
    `https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}/feed`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(formatFacebookApiError(data?.error || {}, response.status));
  }

  return {
    postId: String(data.id || ""),
    pickedItems,
    message,
    uploadedPhotoCount: uploadedPhotoIds.length,
  };
}

async function fetchFacebookPages(userAccessToken) {
  const accessToken = sanitizeAccessToken(userAccessToken);

  if (!accessToken) {
    throw new Error("Facebook user access token is required to load pages.");
  }

  if (!looksLikeFacebookAccessToken(accessToken)) {
    throw new Error("Facebook user access token format looks invalid.");
  }

  const response = await fetch(
    `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token,category&access_token=${encodeURIComponent(accessToken)}`
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(formatFacebookApiError(data?.error || {}, response.status));
  }

  const pages = Array.isArray(data.data) ? data.data : [];
  return pages
    .map((page) => ({
      id: String(page.id || "").trim(),
      name: String(page.name || "").trim(),
      accessToken: sanitizeAccessToken(page.access_token),
      category: String(page.category || "").trim(),
    }))
    .filter((page) => page.id && page.name && page.accessToken);
}

module.exports = {
  fetchFacebookPages,
  postRandomItemsToFacebook,
};
