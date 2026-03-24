const nodemailer = require("nodemailer");
const { getSmtpSettings } = require("../db");
const DELIVERY_LABELS = {
  MANILA: "Manila",
  LUZON: "Luzon",
  VISAYAS: "Visayas",
  MINDANAO: "Mindanao",
};
const ORDER_STATUS_LABELS = {
  PENDING: "Pending",
  PAID: "Paid",
  FOR_DELIVERY: "For Delivery",
  RECEIVED: "Received",
};
const PLACEHOLDER_TOKENS = [
  "your-email@example.com",
  "your-email-password-or-app-password",
  "replace-me",
  "changeme",
];

function formatDeliveryArea(value) {
  const key = String(value || "").toUpperCase();
  return DELIVERY_LABELS[key] || value || "-";
}

function formatOrderStatus(value) {
  const key = String(value || "").toUpperCase();
  return ORDER_STATUS_LABELS[key] || value || "Unknown";
}

function isPlaceholderValue(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return true;
  }

  return PLACEHOLDER_TOKENS.some((token) => text.includes(token));
}

function parseBoolean(value, fallback) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes") {
    return true;
  }
  if (text === "false" || text === "0" || text === "no") {
    return false;
  }
  return fallback;
}

function hasStoredSmtpConfig(settings) {
  return Boolean(
    settings &&
      (settings.host ||
        settings.port ||
        settings.user ||
        settings.pass ||
        settings.fromEmail ||
        settings.fromName)
  );
}

function getResolvedSmtpConfig() {
  const stored = getSmtpSettings();
  const fromStored = hasStoredSmtpConfig(stored);

  const host = String(stored.host || process.env.SMTP_HOST || "").trim();
  const port = Number(stored.port || process.env.SMTP_PORT || 0);
  const secure = parseBoolean(
    stored.secure,
    parseBoolean(process.env.SMTP_SECURE, port === 465)
  );
  const user = String(stored.user || process.env.SMTP_USER || "").trim();
  const pass = String(stored.pass || process.env.SMTP_PASS || "").trim();
  const fromEmail = String(stored.fromEmail || process.env.FROM_EMAIL || user || "").trim();
  const fromName = String(stored.fromName || process.env.FROM_NAME || "Pre-loved by Lhota").trim();
  const rejectUnauthorized = parseBoolean(
    stored.rejectUnauthorized,
    parseBoolean(process.env.SMTP_REJECT_UNAUTHORIZED, true)
  );

  return {
    source: fromStored ? "ADMIN" : "ENV",
    host,
    port,
    secure,
    user,
    pass,
    fromEmail,
    fromName,
    rejectUnauthorized,
  };
}

function getFromAddress(config) {
  const fromEmail = String((config && config.fromEmail) || "").trim();
  const fromName = String((config && config.fromName) || "").trim();

  if (!fromEmail) {
    return "";
  }

  return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
}

function getSmtpConfigStatus() {
  const config = getResolvedSmtpConfig();
  const host = config.host;
  const port = config.port;
  const user = config.user;
  const pass = config.pass;
  const from = config.fromEmail;
  const sourceLabel = config.source === "ADMIN" ? "Admin Settings" : "Environment (.env)";

  if (!host || !port || !user || !pass) {
    return {
      configured: false,
      source: config.source,
      sourceLabel,
      message:
        "SMTP is not fully configured. Set host, port, username, and password in Admin SMTP settings or .env.",
    };
  }

  if (isPlaceholderValue(user) || isPlaceholderValue(pass) || (from && isPlaceholderValue(from))) {
    return {
      configured: false,
      source: config.source,
      sourceLabel,
      message:
        "SMTP uses placeholder values. Replace them with real credentials in Admin SMTP settings or .env.",
    };
  }

  return {
    configured: true,
    source: config.source,
    sourceLabel,
    host,
    port,
    user,
    fromEmail: from,
    message: "SMTP config looks complete.",
  };
}

function getTransport() {
  const status = getSmtpConfigStatus();
  if (!status.configured) {
    return null;
  }

  const config = getResolvedSmtpConfig();

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      rejectUnauthorized: config.rejectUnauthorized,
    },
  });
}

async function verifySmtpConnection() {
  const status = getSmtpConfigStatus();
  if (!status.configured) {
    throw new Error(status.message);
  }

  const transport = getTransport();
  if (!transport) {
    throw new Error("SMTP transport is unavailable.");
  }

  await transport.verify();
  return true;
}

async function sendSmtpTestEmail(toEmail) {
  const status = getSmtpConfigStatus();
  if (!status.configured) {
    throw new Error(status.message);
  }

  const recipient = String(toEmail || "").trim().toLowerCase();
  if (!recipient) {
    throw new Error("Recipient email is required.");
  }

  const transport = getTransport();
  if (!transport) {
    throw new Error("SMTP transport is unavailable.");
  }

  const from = getFromAddress(getResolvedSmtpConfig());
  if (!from) {
    throw new Error("FROM_EMAIL or SMTP_USER must be set.");
  }

  await transport.sendMail({
    from,
    to: recipient,
    subject: "SMTP Test - Pre-loved by Lhota",
    text: [
      "SMTP test email sent successfully.",
      "",
      `Time: ${new Date().toISOString()}`,
      "If you received this message, SMTP is working.",
    ].join("\n"),
  });

  return true;
}

async function sendPendingOrderEmail(order) {
  const transport = getTransport();

  if (!transport) {
    return false;
  }

  const from = getFromAddress(getResolvedSmtpConfig());

  await transport.sendMail({
    from,
    to: order.buyerEmail,
    subject: `Order #${order.id} received - awaiting payment approval`,
    text: [
      `Hi ${order.buyerName},`,
      "",
      `We received your order #${order.id}.`,
      "Your payment is currently pending manual approval.",
      "",
      "Order summary:",
      ...order.items.map(
        (item) => `- ${item.name} x${item.quantity} = PHP ${item.subtotal.toFixed(2)}`
      ),
      `Items Subtotal: PHP ${(order.itemSubtotal || order.totalAmount || 0).toFixed(2)}`,
      `Delivery (${formatDeliveryArea(order.deliveryArea)}): PHP ${(order.deliveryFee || 0).toFixed(2)}`,
      `Grand Total: PHP ${(order.grandTotal || order.totalAmount || 0).toFixed(2)}`,
      "",
      "We will email you again once it is approved.",
      "",
      "Thank you.",
    ].join("\n"),
  });

  return true;
}

async function sendApprovedOrderEmail(order) {
  const transport = getTransport();

  if (!transport) {
    return false;
  }

  const from = getFromAddress(getResolvedSmtpConfig());

  await transport.sendMail({
    from,
    to: order.buyerEmail,
    subject: `Payment approved for order #${order.id}`,
    text: [
      `Hi ${order.buyerName},`,
      "",
      `Your payment for order #${order.id} has been approved.`,
      "We will now prepare your preloved items for delivery.",
      "",
      "Order summary:",
      ...order.items.map(
        (item) => `- ${item.name} x${item.quantity} = PHP ${item.subtotal.toFixed(2)}`
      ),
      `Items Subtotal: PHP ${(order.itemSubtotal || order.totalAmount || 0).toFixed(2)}`,
      `Delivery (${formatDeliveryArea(order.deliveryArea)}): PHP ${(order.deliveryFee || 0).toFixed(2)}`,
      `Grand Total: PHP ${(order.grandTotal || order.totalAmount || 0).toFixed(2)}`,
      "",
      "Thank you for your purchase.",
    ].join("\n"),
  });

  return true;
}

async function sendOrderStatusUpdateEmail(order) {
  const transport = getTransport();

  if (!transport) {
    return false;
  }

  const from = getFromAddress(getResolvedSmtpConfig());
  const statusLabel = formatOrderStatus(order.status);

  await transport.sendMail({
    from,
    to: order.buyerEmail,
    subject: `Order #${order.id} update: ${statusLabel}`,
    text: [
      `Hi ${order.buyerName},`,
      "",
      `Your order #${order.id} is now marked as: ${statusLabel}.`,
      "",
      "Order summary:",
      ...order.items.map(
        (item) => `- ${item.name} x${item.quantity} = PHP ${item.subtotal.toFixed(2)}`
      ),
      `Items Subtotal: PHP ${(order.itemSubtotal || order.totalAmount || 0).toFixed(2)}`,
      `Delivery (${formatDeliveryArea(order.deliveryArea)}): PHP ${(order.deliveryFee || 0).toFixed(2)}`,
      `Grand Total: PHP ${(order.grandTotal || order.totalAmount || 0).toFixed(2)}`,
      "",
      "Thank you for your purchase.",
    ].join("\n"),
  });

  return true;
}

async function sendNewOrderAdminEmail(adminEmail, order) {
  const transport = getTransport();

  if (!transport || !adminEmail) {
    return false;
  }

  const from = getFromAddress(getResolvedSmtpConfig());

  await transport.sendMail({
    from,
    to: adminEmail,
    subject: `New order received: #${order.id}`,
    text: [
      "A new order has been placed and is pending payment approval.",
      "",
      `Order ID: #${order.id}`,
      `Buyer: ${order.buyerName}`,
      `Email: ${order.buyerEmail}`,
      `Phone: ${order.buyerPhone}`,
      `Delivery Address: ${order.deliveryAddress}`,
      `Delivery Area: ${formatDeliveryArea(order.deliveryArea)}`,
      `Delivery Fee: PHP ${(order.deliveryFee || 0).toFixed(2)}`,
      `Items Subtotal: PHP ${(order.itemSubtotal || order.totalAmount || 0).toFixed(2)}`,
      `Grand Total: PHP ${(order.grandTotal || order.totalAmount || 0).toFixed(2)}`,
      "",
      "Items:",
      ...order.items.map(
        (item) => `- ${item.name} x${item.quantity} = PHP ${item.subtotal.toFixed(2)}`
      ),
      "",
      "Please review and process this order in Admin > Orders.",
    ].join("\n"),
  });

  return true;
}

async function sendUnprocessedOrderReminderEmail(adminEmail, order, ageHours) {
  const transport = getTransport();

  if (!transport || !adminEmail) {
    return false;
  }

  const from = getFromAddress(getResolvedSmtpConfig());

  await transport.sendMail({
    from,
    to: adminEmail,
    subject: `Order #${order.id} still not processed`,
    text: [
      `Order #${order.id} has remained pending for ${ageHours} hour(s).`,
      "",
      `Buyer: ${order.buyerName} (${order.buyerEmail})`,
      `Created At: ${order.createdAt}`,
      `Grand Total: PHP ${(order.grandTotal || order.totalAmount || 0).toFixed(2)}`,
      "",
      "Please review this order in Admin > Orders.",
    ].join("\n"),
  });

  return true;
}

module.exports = {
  formatOrderStatus,
  getSmtpConfigStatus,
  verifySmtpConnection,
  sendSmtpTestEmail,
  sendPendingOrderEmail,
  sendApprovedOrderEmail,
  sendOrderStatusUpdateEmail,
  sendNewOrderAdminEmail,
  sendUnprocessedOrderReminderEmail,
};
