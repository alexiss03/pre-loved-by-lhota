(function () {
  const CART_KEY = String(window.STORE_CART_KEY || "preloved_cart");
  const STORE_BASE_PATH = String(window.STORE_BASE_PATH || "");
  const catalog = Array.isArray(window.ITEM_CATALOG) ? window.ITEM_CATALOG : [];
  const modal = document.getElementById("cart-modal");
  const modalClose = document.getElementById("cart-modal-close");
  const modalCancel = document.getElementById("cart-modal-cancel");
  const modalConfirm = document.getElementById("cart-modal-confirm");
  const modalTitle = document.getElementById("cart-modal-title");
  const modalMessage = document.getElementById("cart-modal-message");
  const modalPiecesInput = document.getElementById("cart-modal-pieces-input");
  const feedGrid = document.getElementById("endless-feed-grid");
  const feedSentinel = document.getElementById("endless-feed-sentinel");
  let feedCursor = feedGrid ? Number(feedGrid.getAttribute("data-feed-cursor") || 0) : 0;
  const feedBatchSize = feedGrid ? Number(feedGrid.getAttribute("data-batch-size") || 4) : 4;
  let isAppendingFeed = false;
  let feedObserver = null;
  let fallbackScrollHandler = null;
  let pendingItemId = null;

  function getCart() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CART_KEY));
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {
      return [];
    }

    return [];
  }

  function setCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    window.dispatchEvent(new CustomEvent("preloved-cart-updated"));
  }

  function openModal() {
    if (!modal) {
      return;
    }

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    if (!modal) {
      return;
    }

    pendingItemId = null;
    modal.classList.remove("is-open");
    modal.classList.remove("is-error");
    modal.setAttribute("aria-hidden", "true");

    if (modalTitle) {
      modalTitle.textContent = "Add to Cart";
    }

    if (modalMessage) {
      modalMessage.textContent = "How many pieces would you like to add?";
    }

    if (modalConfirm) {
      modalConfirm.disabled = false;
      modalConfirm.textContent = "Confirm Add";
    }

    if (modalPiecesInput) {
      modalPiecesInput.disabled = false;
      modalPiecesInput.value = "1";
      modalPiecesInput.setAttribute("max", "1");
    }
  }

  function getCurrentCartQuantity(itemId) {
    const cart = getCart();
    const existing = cart.find((entry) => entry.itemId === itemId);
    if (!existing) {
      return 0;
    }

    return Number(existing.quantity) || 0;
  }

  function getRemainingStock(product, itemId) {
    const stock = Number(product.stock) || 0;
    const currentCartQty = getCurrentCartQuantity(itemId);
    return Math.max(stock - currentCartQty, 0);
  }

  function clampPiecesInputValue() {
    if (!modalPiecesInput) {
      return 1;
    }

    const min = Number(modalPiecesInput.getAttribute("min") || 1);
    const max = Number(modalPiecesInput.getAttribute("max") || 1);
    let value = Number(modalPiecesInput.value);

    if (!Number.isInteger(value) || value < min) {
      value = min;
    }

    if (value > max) {
      value = max;
    }

    modalPiecesInput.value = String(value);
    return value;
  }

  function addItem(itemId, quantityToAdd) {
    const product = catalog.find((entry) => entry.id === itemId);
    if (!product) {
      return {
        ok: false,
        message: "Item not found.",
      };
    }

    const pieces = Number(quantityToAdd);
    if (!Number.isInteger(pieces) || pieces < 1) {
      return {
        ok: false,
        message: "Please enter a valid number of pieces.",
      };
    }

    const cart = getCart();
    const existing = cart.find((entry) => entry.itemId === itemId);
    const currentQuantity = existing ? Number(existing.quantity) || 0 : 0;
    const nextQuantity = currentQuantity + pieces;

    if (nextQuantity > product.stock) {
      const remaining = Math.max(product.stock - currentQuantity, 0);
      return {
        ok: false,
        message: `Only ${remaining} piece(s) left for ${product.name}. Please reduce your pieces.`,
      };
    }

    if (existing) {
      existing.quantity = nextQuantity;
    } else {
      cart.push({ itemId, quantity: pieces });
    }

    setCart(cart);
    return {
      ok: true,
      message: `${pieces} piece(s) of ${product.name} added to your cart.`,
    };
  }

  function openConfirmModal(itemId) {
    const product = catalog.find((entry) => entry.id === itemId);
    if (!product || !modal) {
      return;
    }

    pendingItemId = itemId;
    const remaining = getRemainingStock(product, itemId);

    if (modalTitle) {
      modalTitle.textContent = "Add to Cart";
    }

    if (modalMessage) {
      if (remaining < 1) {
        modalMessage.textContent = `${product.name} is already maxed out in your cart.`;
      } else {
        modalMessage.textContent = `How many pieces of ${product.name} would you like to add?`;
      }
    }

    if (modalPiecesInput) {
      modalPiecesInput.setAttribute("min", "1");
      modalPiecesInput.setAttribute("max", String(Math.max(remaining, 1)));
      modalPiecesInput.value = "1";
      modalPiecesInput.disabled = remaining < 1;
    }

    if (modalConfirm) {
      modalConfirm.disabled = remaining < 1;
      modalConfirm.textContent = remaining < 1 ? "No Stock Left" : "Confirm Add";
    }

    modal.classList.remove("is-error");
    openModal();
  }

  function handleModalConfirm() {
    if (!pendingItemId || !modal) {
      closeModal();
      return;
    }

    const pieces = clampPiecesInputValue();
    const result = addItem(pendingItemId, pieces);

    if (modalTitle) {
      modalTitle.textContent = result.ok ? "Added to Cart" : "Add to Cart";
    }

    if (modalMessage) {
      modalMessage.textContent = result.message;
    }

    modal.classList.toggle("is-error", !result.ok);

    if (!result.ok) {
      return;
    }

    const product = catalog.find((entry) => entry.id === pendingItemId);
    if (!product) {
      return;
    }

    const remaining = getRemainingStock(product, pendingItemId);
    if (modalPiecesInput) {
      modalPiecesInput.setAttribute("max", String(Math.max(remaining, 1)));
      modalPiecesInput.value = "1";
      modalPiecesInput.disabled = remaining < 1;
    }

    if (modalConfirm) {
      modalConfirm.disabled = remaining < 1;
      modalConfirm.textContent = remaining < 1 ? "No Stock Left" : "Confirm Add";
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderFeedItemCard(item) {
    const safeId = escapeHtml(item.id);
    const safeName = escapeHtml(item.name);
    const safeCategory = escapeHtml(item.category);
    const safeDescription = escapeHtml(item.description);
    const safeImageUrl = escapeHtml(item.imageUrl);
    const stock = Number(item.stock) || 0;
    const outOfStock = stock < 1;
    const formattedPrice = `PHP ${Number(item.price).toFixed(2)}`;

    return `
      <article class="item-card">
        <a class="item-image-link" href="${STORE_BASE_PATH}/product/${encodeURIComponent(item.id)}">
          <img src="${safeImageUrl}" alt="${safeName}" />
        </a>
        <div class="item-card-body">
          <span class="item-category">${safeCategory}</span>
          <h3><a class="item-title-link" href="${STORE_BASE_PATH}/product/${encodeURIComponent(item.id)}">${safeName}</a></h3>
          <p class="item-description">${safeDescription}</p>
          <p class="stock-text">${stock} pieces available</p>
          <p class="price">${formattedPrice}</p>
          <button class="button button-primary add-to-cart" data-item-id="${safeId}" ${outOfStock ? "disabled" : ""}>
            ${outOfStock ? "Out of Stock" : "Add to Cart"}
          </button>
          <a class="button view-detail-btn" href="${STORE_BASE_PATH}/product/${encodeURIComponent(item.id)}">View Details</a>
        </div>
      </article>
    `;
  }

  function appendFeedBatch() {
    if (!feedGrid || catalog.length === 0 || isAppendingFeed) {
      return;
    }

    if (feedCursor >= catalog.length) {
      if (feedSentinel) {
        feedSentinel.textContent = "All items loaded.";
      }
      if (feedObserver) {
        feedObserver.disconnect();
        feedObserver = null;
      }
      if (fallbackScrollHandler) {
        window.removeEventListener("scroll", fallbackScrollHandler);
        fallbackScrollHandler = null;
      }
      return;
    }

    isAppendingFeed = true;

    const cards = [];
    const endCursor = Math.min(feedCursor + feedBatchSize, catalog.length);
    for (let feedIndex = feedCursor; feedIndex < endCursor; feedIndex += 1) {
      const item = catalog[feedIndex];
      cards.push(renderFeedItemCard(item));
    }

    feedGrid.insertAdjacentHTML("beforeend", cards.join(""));
    feedCursor = endCursor;
    isAppendingFeed = false;

    if (feedSentinel) {
      feedSentinel.textContent = feedCursor >= catalog.length ? "All items loaded." : "Loading more items...";
    }

    if (feedCursor >= catalog.length) {
      if (feedObserver) {
        feedObserver.disconnect();
        feedObserver = null;
      }
      if (fallbackScrollHandler) {
        window.removeEventListener("scroll", fallbackScrollHandler);
        fallbackScrollHandler = null;
      }
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest(".add-to-cart");
    if (!button) {
      return;
    }

    const itemId = button.getAttribute("data-item-id");
    openConfirmModal(itemId);
  });

  if (modalPiecesInput) {
    modalPiecesInput.addEventListener("input", clampPiecesInputValue);
    modalPiecesInput.addEventListener("change", clampPiecesInputValue);
  }

  if (modalConfirm) {
    modalConfirm.addEventListener("click", handleModalConfirm);
  }

  if (modalCancel) {
    modalCancel.addEventListener("click", closeModal);
  }

  if (modalClose) {
    modalClose.addEventListener("click", closeModal);
  }

  if (modal) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        closeModal();
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
      return;
    }

    if (event.key === "Enter" && modal && modal.classList.contains("is-open")) {
      const target = event.target;
      if (target === modalPiecesInput || target === modalConfirm) {
        event.preventDefault();
        handleModalConfirm();
      }
    }
  });

  if (feedGrid && feedSentinel && catalog.length > 0) {
    if (feedCursor >= catalog.length) {
      feedSentinel.textContent = "All items loaded.";
      return;
    }

    if ("IntersectionObserver" in window) {
      feedObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              appendFeedBatch();
            }
          }
        },
        { rootMargin: "500px 0px" }
      );
      feedObserver.observe(feedSentinel);
    } else {
      fallbackScrollHandler = () => {
        const rect = feedSentinel.getBoundingClientRect();
        if (rect.top < window.innerHeight + 500) {
          appendFeedBatch();
        }
      };
      window.addEventListener("scroll", fallbackScrollHandler);
    }
  }
})();
