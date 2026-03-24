(function () {
  const CART_KEY = "preloved_cart";
  const LOCATION_API_BASES = ["https://psgc.cloud/api", "https://psgc.cloud/api/v1"];

  const catalog = Array.isArray(window.ITEM_CATALOG) ? window.ITEM_CATALOG : [];
  const deliveryFees = window.DELIVERY_FEES && typeof window.DELIVERY_FEES === "object" ? window.DELIVERY_FEES : {};
  const paymongoCheckout = window.PAYMONGO_CHECKOUT && typeof window.PAYMONGO_CHECKOUT === "object"
    ? window.PAYMONGO_CHECKOUT
    : { step: 50, links: {} };

  const cartItemsContainer = document.getElementById("cart-items");
  const cartEmptyElement = document.getElementById("cart-empty");
  const subtotalElement = document.getElementById("cart-subtotal");
  const detectedAreaElement = document.getElementById("detected-area");
  const deliveryFeeElement = document.getElementById("delivery-fee");
  const grandTotalElement = document.getElementById("cart-grand-total");

  const cartDataInput = document.getElementById("cartDataInput");
  const checkoutForm = document.getElementById("checkout-form");
  const accountFieldsWrap = document.getElementById("account-fields");
  const accountPasswordInput = document.getElementById("accountPassword");
  const accountPasswordConfirmInput = document.getElementById("accountPasswordConfirm");
  const checkoutModeInputs = Array.from(document.querySelectorAll("input[name='checkoutMode']"));

  const deliveryRegionCodeInput = document.getElementById("deliveryRegionCode");
  const deliveryCityCodeInput = document.getElementById("deliveryCityCode");
  const deliveryBarangayCodeInput = document.getElementById("deliveryBarangayCode");
  const deliveryAddressLineInput = document.getElementById("deliveryAddressLine");

  const deliveryRegionInput = document.getElementById("deliveryRegion");
  const deliveryCityInput = document.getElementById("deliveryCity");
  const deliveryBarangayInput = document.getElementById("deliveryBarangay");
  const deliveryAreaInput = document.getElementById("deliveryArea");
  const deliveryAddressInput = document.getElementById("deliveryAddress");
  const locationLoadStatus = document.getElementById("location-load-status");

  const checkoutShopSearch = document.getElementById("checkout-shop-search");
  const checkoutShopCategory = document.getElementById("checkout-shop-category");
  const checkoutShopItems = Array.from(document.querySelectorAll(".checkout-shop-item"));
  const checkoutShopEmpty = document.getElementById("checkout-shop-empty");
  const checkoutShopFeedback = document.getElementById("checkout-shop-feedback");
  const paymongoCheckoutStatus = document.getElementById("paymongo-checkout-status");
  const paymongoCheckoutLink = document.getElementById("paymongo-checkout-link");

  const AREA_LABELS = {
    MANILA: "Manila",
    LUZON: "Luzon",
    VISAYAS: "Visayas",
    MINDANAO: "Mindanao",
  };

  function currency(value) {
    return `PHP ${Number(value).toFixed(2)}`;
  }

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

  function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    window.dispatchEvent(new CustomEvent("preloved-cart-updated"));
  }

  function normalizeCart(cart) {
    return cart
      .map((entry) => ({
        itemId: String(entry.itemId),
        quantity: Number(entry.quantity),
      }))
      .filter((entry) => {
        const product = catalog.find((item) => item.id === entry.itemId);
        if (!product) {
          return false;
        }
        return Number.isFinite(entry.quantity) && entry.quantity > 0;
      });
  }

  function getItemSubtotal(cart) {
    return cart.reduce((sum, entry) => {
      const product = catalog.find((item) => item.id === entry.itemId);
      return product ? sum + product.price * entry.quantity : sum;
    }, 0);
  }

  function applyDirectBuyFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const buyItemId = params.get("buyItem");

    if (!buyItemId) {
      return;
    }

    const product = catalog.find((item) => item.id === buyItemId);
    if (!product) {
      return;
    }

    let quantity = Number(params.get("qty") || 1);
    if (!Number.isInteger(quantity) || quantity < 1) {
      quantity = 1;
    }

    if (product.stock > 0) {
      quantity = Math.min(quantity, product.stock);
    }

    saveCart([{ itemId: product.id, quantity }]);

    params.delete("buyItem");
    params.delete("qty");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
    window.history.replaceState({}, "", nextUrl);
  }

  function normalizeArea(value) {
    return String(value || "").trim().toUpperCase();
  }

  function deriveAreaFromRegion(regionCode, regionName) {
    const codeText = String(regionCode || "").trim();
    const nameText = String(regionName || "").toLowerCase();

    if (codeText === "1300000000") {
      return "MANILA";
    }

    const regionNumber = Number(codeText.slice(0, 2));
    if ([1, 2, 3, 4, 5, 13, 14, 17].includes(regionNumber)) {
      return "LUZON";
    }

    if ([6, 7, 8, 18].includes(regionNumber)) {
      return "VISAYAS";
    }

    if ([9, 10, 11, 12, 15, 16, 19].includes(regionNumber)) {
      return "MINDANAO";
    }

    if (nameText.includes("manila") || nameText.includes("ncr")) {
      return "MANILA";
    }

    if (nameText.includes("visayas")) {
      return "VISAYAS";
    }

    if (nameText.includes("mindanao")) {
      return "MINDANAO";
    }

    if (nameText.includes("luzon")) {
      return "LUZON";
    }

    return "";
  }

  function getSelectedOptionText(select) {
    if (!select || select.selectedIndex < 0) {
      return "";
    }

    const option = select.options[select.selectedIndex];
    if (!option || !option.value) {
      return "";
    }

    return option.getAttribute("data-name") || option.textContent || "";
  }

  function updateHiddenLocationFields() {
    const regionCode = deliveryRegionCodeInput ? String(deliveryRegionCodeInput.value || "") : "";
    const cityCode = deliveryCityCodeInput ? String(deliveryCityCodeInput.value || "") : "";
    const barangayCode = deliveryBarangayCodeInput ? String(deliveryBarangayCodeInput.value || "") : "";

    const regionName = getSelectedOptionText(deliveryRegionCodeInput);
    const cityName = getSelectedOptionText(deliveryCityCodeInput);
    const barangayName = getSelectedOptionText(deliveryBarangayCodeInput);

    const area = deriveAreaFromRegion(regionCode, regionName);

    if (deliveryRegionInput) {
      deliveryRegionInput.value = regionName;
    }

    if (deliveryCityInput) {
      deliveryCityInput.value = cityName;
    }

    if (deliveryBarangayInput) {
      deliveryBarangayInput.value = barangayName;
    }

    if (deliveryAreaInput) {
      deliveryAreaInput.value = area;
    }

    const addressLine = deliveryAddressLineInput ? String(deliveryAddressLineInput.value || "").trim() : "";
    const composedAddress = [addressLine, barangayName, cityName, regionName].filter(Boolean).join(", ");
    if (deliveryAddressInput) {
      deliveryAddressInput.value = composedAddress;
    }

    if (deliveryRegionCodeInput) {
      deliveryRegionCodeInput.setAttribute("data-selected-code", regionCode);
    }

    if (deliveryCityCodeInput) {
      deliveryCityCodeInput.setAttribute("data-selected-code", cityCode);
    }

    if (deliveryBarangayCodeInput) {
      deliveryBarangayCodeInput.setAttribute("data-selected-code", barangayCode);
    }
  }

  function getDeliveryFromLocation() {
    const area = normalizeArea(deliveryAreaInput ? deliveryAreaInput.value : "");
    const fee = Number(deliveryFees[area] || 0);

    return {
      area,
      fee: Number.isFinite(fee) ? fee : 0,
    };
  }

  function renderTotals(itemSubtotal) {
    const delivery = getDeliveryFromLocation();
    const deliveryFee = delivery.fee;
    const grandTotal = itemSubtotal + deliveryFee;

    if (subtotalElement) {
      subtotalElement.textContent = currency(itemSubtotal);
    }

    if (detectedAreaElement) {
      detectedAreaElement.textContent = AREA_LABELS[delivery.area] || "-";
    }

    if (deliveryFeeElement) {
      deliveryFeeElement.textContent = currency(deliveryFee);
    }

    if (grandTotalElement) {
      grandTotalElement.textContent = currency(grandTotal);
    }

    renderPaymongoCheckoutLink(grandTotal);
  }

  function getPaymongoAmountTarget(total) {
    const step = Number(paymongoCheckout.step) || 50;
    if (!Number.isFinite(total) || total <= 0) {
      return 0;
    }
    return Math.ceil(total / step) * step;
  }

  function renderPaymongoCheckoutLink(grandTotal) {
    if (!paymongoCheckoutStatus || !paymongoCheckoutLink) {
      return;
    }

    const step = Number(paymongoCheckout.step) || 50;
    const links = paymongoCheckout && typeof paymongoCheckout.links === "object"
      ? paymongoCheckout.links
      : {};

    const amountTarget = getPaymongoAmountTarget(grandTotal);
    if (amountTarget <= 0) {
      paymongoCheckoutStatus.textContent = "";
      paymongoCheckoutStatus.hidden = true;
      paymongoCheckoutLink.hidden = true;
      paymongoCheckoutLink.setAttribute("href", "#");
      return;
    }

    const mappedLink = String(links[String(amountTarget)] || "").trim();
    if (!mappedLink) {
      paymongoCheckoutStatus.hidden = false;
      paymongoCheckoutStatus.textContent =
        `No PayMongo link configured for PHP ${amountTarget.toFixed(2)}. Set it in Admin (every PHP ${step}).`;
      paymongoCheckoutLink.hidden = true;
      paymongoCheckoutLink.setAttribute("href", "#");
      return;
    }

    paymongoCheckoutStatus.hidden = false;
    paymongoCheckoutStatus.textContent =
      `PayMongo checkout for PHP ${amountTarget.toFixed(2)} (rounded up by PHP ${step}).`;
    paymongoCheckoutLink.hidden = false;
    paymongoCheckoutLink.setAttribute("href", mappedLink);
  }

  function getCheckoutMode() {
    const selected = checkoutModeInputs.find((input) => input.checked);
    return selected ? String(selected.value || "GUEST").toUpperCase() : "GUEST";
  }

  function renderCheckoutMode() {
    const isCreateAccount = getCheckoutMode() === "CREATE_ACCOUNT";

    if (accountFieldsWrap) {
      accountFieldsWrap.hidden = !isCreateAccount;
    }

    if (accountPasswordInput) {
      accountPasswordInput.required = isCreateAccount;
    }

    if (accountPasswordConfirmInput) {
      accountPasswordConfirmInput.required = isCreateAccount;
    }
  }

  function showCheckoutFeedback(message, isError) {
    if (!checkoutShopFeedback) {
      return;
    }

    checkoutShopFeedback.hidden = false;
    checkoutShopFeedback.textContent = message;
    checkoutShopFeedback.classList.remove("is-error", "is-success");
    checkoutShopFeedback.classList.add(isError ? "is-error" : "is-success");
  }

  function addItemFromCheckoutShop(itemId, pieces) {
    const product = catalog.find((item) => item.id === itemId);
    if (!product) {
      return;
    }

    if (!Number.isInteger(pieces) || pieces < 1) {
      showCheckoutFeedback("Please enter a valid number of pieces.", true);
      return;
    }

    const cart = normalizeCart(getCart());
    const existing = cart.find((entry) => entry.itemId === itemId);
    const currentQuantity = existing ? existing.quantity : 0;
    const nextQuantity = currentQuantity + pieces;

    if (nextQuantity > product.stock) {
      const remaining = Math.max(product.stock - currentQuantity, 0);
      showCheckoutFeedback(
        `Only ${remaining} piece(s) left for ${product.name}. Reduce quantity.`,
        true
      );
      return;
    }

    if (existing) {
      existing.quantity = nextQuantity;
    } else {
      cart.push({ itemId, quantity: pieces });
    }

    saveCart(cart);
    render();
    showCheckoutFeedback(`${pieces} piece(s) of ${product.name} added to cart.`, false);
  }

  function filterCheckoutShopItems() {
    if (checkoutShopItems.length === 0) {
      return;
    }

    const query = String(checkoutShopSearch ? checkoutShopSearch.value : "")
      .trim()
      .toLowerCase();
    const selectedCategory = String(checkoutShopCategory ? checkoutShopCategory.value : "ALL");
    let visibleCount = 0;

    checkoutShopItems.forEach((itemCard) => {
      const category = String(itemCard.getAttribute("data-category") || "");
      const searchable = [
        itemCard.getAttribute("data-name") || "",
        itemCard.getAttribute("data-description") || "",
        category.toLowerCase(),
      ].join(" ");

      const categoryMatch = selectedCategory === "ALL" || category === selectedCategory;
      const queryMatch = query === "" || searchable.includes(query);
      const show = categoryMatch && queryMatch;

      itemCard.style.display = show ? "" : "none";
      if (show) {
        visibleCount += 1;
      }
    });

    if (checkoutShopEmpty) {
      checkoutShopEmpty.hidden = visibleCount > 0;
    }
  }

  function render() {
    const cart = normalizeCart(getCart());
    saveCart(cart);

    if (cart.length === 0) {
      if (cartEmptyElement) {
        cartEmptyElement.style.display = "block";
      }
      if (cartItemsContainer) {
        cartItemsContainer.innerHTML = "";
      }
      renderTotals(0);
      if (cartDataInput) {
        cartDataInput.value = JSON.stringify([]);
      }
      return;
    }

    if (cartEmptyElement) {
      cartEmptyElement.style.display = "none";
    }

    let total = 0;
    const rows = cart
      .map((entry) => {
        const product = catalog.find((item) => item.id === entry.itemId);
        if (!product) {
          return "";
        }

        const subtotal = product.price * entry.quantity;
        total += subtotal;

        return `
          <div class="cart-item-row">
            <div>
              <strong>${product.name}</strong>
              <p class="muted">${product.category} | ${currency(product.price)} each</p>
            </div>
            <div class="qty-controls">
              <button type="button" data-action="decrease" data-item-id="${product.id}">-</button>
              <span>${entry.quantity}</span>
              <button type="button" data-action="increase" data-item-id="${product.id}">+</button>
              <button type="button" class="remove-btn" data-action="remove" data-item-id="${product.id}">Remove</button>
            </div>
            <div><strong>${currency(subtotal)}</strong></div>
          </div>
        `;
      })
      .join("");

    if (cartItemsContainer) {
      cartItemsContainer.innerHTML = rows;
    }
    renderTotals(total);

    if (cartDataInput) {
      cartDataInput.value = JSON.stringify(cart);
    }

    bindControls();
  }

  function updateQuantity(itemId, nextQuantity) {
    const cart = normalizeCart(getCart());
    const product = catalog.find((entry) => entry.id === itemId);
    if (!product) {
      return;
    }

    const existing = cart.find((entry) => entry.itemId === itemId);
    if (!existing) {
      return;
    }

    if (nextQuantity <= 0) {
      const filtered = cart.filter((entry) => entry.itemId !== itemId);
      saveCart(filtered);
      render();
      return;
    }

    if (nextQuantity > product.stock) {
      alert("Quantity exceeds current stock.");
      return;
    }

    existing.quantity = nextQuantity;
    saveCart(cart);
    render();
  }

  function bindControls() {
    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.getAttribute("data-action");
        const itemId = button.getAttribute("data-item-id");
        const cart = normalizeCart(getCart());
        const existing = cart.find((entry) => entry.itemId === itemId);
        if (!existing) {
          return;
        }

        if (action === "increase") {
          updateQuantity(itemId, existing.quantity + 1);
        }

        if (action === "decrease") {
          updateQuantity(itemId, existing.quantity - 1);
        }

        if (action === "remove") {
          updateQuantity(itemId, 0);
        }
      });
    });
  }

  function normalizeLocationList(payload) {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && Array.isArray(payload.data)) {
      return payload.data;
    }

    if (payload && payload.result && Array.isArray(payload.result.data)) {
      return payload.result.data;
    }

    return [];
  }

  async function fetchLocationList(path) {
    let lastError = null;

    for (const base of LOCATION_API_BASES) {
      const url = `${base}${path}`;
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          lastError = new Error(`Request failed (${response.status})`);
          continue;
        }

        const data = await response.json();
        const list = normalizeLocationList(data);
        if (Array.isArray(list)) {
          return list;
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Failed to fetch location data.");
  }

  function setSelectPlaceholder(select, text, disabled) {
    if (!select) {
      return;
    }

    select.innerHTML = `<option value="">${text}</option>`;
    select.disabled = Boolean(disabled);
    select.value = "";
  }

  function populateSelect(select, items, formatter) {
    if (!select) {
      return;
    }

    const options = items
      .map((item) => {
        const value = String(item.code || "").trim();
        const name = String(item.name || "").trim();
        if (!value || !name) {
          return "";
        }

        const label = formatter ? formatter(item) : name;
        return `<option value="${value}" data-name="${name}">${label}</option>`;
      })
      .join("");

    select.insertAdjacentHTML("beforeend", options);
  }

  async function loadRegions() {
    if (!deliveryRegionCodeInput) {
      return;
    }

    setSelectPlaceholder(deliveryRegionCodeInput, "Select region", true);

    const regions = await fetchLocationList("/regions");
    const sorted = [...regions].sort((a, b) => String(a.name).localeCompare(String(b.name)));

    setSelectPlaceholder(deliveryRegionCodeInput, "Select region", false);
    populateSelect(deliveryRegionCodeInput, sorted);
  }

  async function loadCitiesByRegion(regionCode) {
    if (!deliveryCityCodeInput) {
      return;
    }

    setSelectPlaceholder(deliveryCityCodeInput, "Loading cities/municipalities...", true);
    setSelectPlaceholder(deliveryBarangayCodeInput, "Select city first", true);

    const cities = await fetchLocationList(`/regions/${encodeURIComponent(regionCode)}/cities-municipalities`);
    const sorted = [...cities].sort((a, b) => String(a.name).localeCompare(String(b.name)));

    setSelectPlaceholder(deliveryCityCodeInput, "Select city / municipality", false);
    populateSelect(deliveryCityCodeInput, sorted, (item) => {
      const baseName = String(item.name || "");
      const type = String(item.type || "");
      if (type === "SubMun") {
        return `${baseName} (District)`;
      }
      return baseName;
    });
  }

  async function loadBarangaysByCity(cityCode) {
    if (!deliveryBarangayCodeInput) {
      return;
    }

    setSelectPlaceholder(deliveryBarangayCodeInput, "Loading barangays...", true);

    const barangays = await fetchLocationList(`/cities-municipalities/${encodeURIComponent(cityCode)}/barangays`);
    const sorted = [...barangays].sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (sorted.length === 0) {
      setSelectPlaceholder(deliveryBarangayCodeInput, "No barangays found for selected city", true);
      return;
    }

    setSelectPlaceholder(deliveryBarangayCodeInput, "Select barangay", false);
    populateSelect(deliveryBarangayCodeInput, sorted);
  }

  function rerenderTotalsFromCurrentCart() {
    const cart = normalizeCart(getCart());
    renderTotals(getItemSubtotal(cart));
  }

  async function initializeLocationSelectors() {
    if (!deliveryRegionCodeInput || !deliveryCityCodeInput || !deliveryBarangayCodeInput) {
      return;
    }

    try {
      if (locationLoadStatus) {
        locationLoadStatus.textContent = "Loading Philippine location list from internet...";
      }

      await loadRegions();

      if (locationLoadStatus) {
        locationLoadStatus.textContent = "Location list loaded. Select your region, city/municipality, and barangay.";
      }
    } catch (error) {
      if (locationLoadStatus) {
        locationLoadStatus.textContent = "Failed to load location list from internet. Please refresh and try again.";
      }
      console.error("Failed to load regions:", error.message);
    }

    deliveryRegionCodeInput.addEventListener("change", async () => {
      updateHiddenLocationFields();
      rerenderTotalsFromCurrentCart();

      const regionCode = String(deliveryRegionCodeInput.value || "").trim();
      if (!regionCode) {
        setSelectPlaceholder(deliveryCityCodeInput, "Select region first", true);
        setSelectPlaceholder(deliveryBarangayCodeInput, "Select city first", true);
        updateHiddenLocationFields();
        rerenderTotalsFromCurrentCart();
        return;
      }

      try {
        await loadCitiesByRegion(regionCode);
      } catch (error) {
        setSelectPlaceholder(deliveryCityCodeInput, "Failed to load cities. Select region again.", true);
        setSelectPlaceholder(deliveryBarangayCodeInput, "Select city first", true);
        console.error("Failed to load cities:", error.message);
      }

      updateHiddenLocationFields();
      rerenderTotalsFromCurrentCart();
    });

    deliveryCityCodeInput.addEventListener("change", async () => {
      updateHiddenLocationFields();
      rerenderTotalsFromCurrentCart();

      const cityCode = String(deliveryCityCodeInput.value || "").trim();
      if (!cityCode) {
        setSelectPlaceholder(deliveryBarangayCodeInput, "Select city first", true);
        updateHiddenLocationFields();
        rerenderTotalsFromCurrentCart();
        return;
      }

      try {
        await loadBarangaysByCity(cityCode);
      } catch (error) {
        setSelectPlaceholder(deliveryBarangayCodeInput, "Failed to load barangays. Select city again.", true);
        console.error("Failed to load barangays:", error.message);
      }

      updateHiddenLocationFields();
      rerenderTotalsFromCurrentCart();
    });

    deliveryBarangayCodeInput.addEventListener("change", () => {
      updateHiddenLocationFields();
      rerenderTotalsFromCurrentCart();
    });

    if (deliveryAddressLineInput) {
      deliveryAddressLineInput.addEventListener("input", () => {
        updateHiddenLocationFields();
        rerenderTotalsFromCurrentCart();
      });
    }
  }

  if (checkoutForm) {
    checkoutForm.addEventListener("submit", (event) => {
      const cart = normalizeCart(getCart());

      if (cart.length === 0) {
        event.preventDefault();
        alert("Your cart is empty.");
        return;
      }

      updateHiddenLocationFields();
      const delivery = getDeliveryFromLocation();

      if (!deliveryRegionCodeInput || !deliveryRegionCodeInput.value) {
        event.preventDefault();
        alert("Please select your region.");
        return;
      }

      if (!deliveryCityCodeInput || !deliveryCityCodeInput.value) {
        event.preventDefault();
        alert("Please select your city or municipality.");
        return;
      }

      if (!deliveryBarangayCodeInput || !deliveryBarangayCodeInput.value) {
        event.preventDefault();
        alert("Please select your barangay.");
        return;
      }

      if (!deliveryAddressLineInput || String(deliveryAddressLineInput.value || "").trim() === "") {
        event.preventDefault();
        alert("Please enter your street / house / unit address.");
        return;
      }

      if (!delivery.area) {
        event.preventDefault();
        alert("Unable to compute delivery fee from selected region. Please choose a valid location.");
        return;
      }

      if (getCheckoutMode() === "CREATE_ACCOUNT") {
        const password = accountPasswordInput ? String(accountPasswordInput.value || "") : "";
        const confirmPassword = accountPasswordConfirmInput
          ? String(accountPasswordConfirmInput.value || "")
          : "";

        if (password.length < 8) {
          event.preventDefault();
          alert("Password must be at least 8 characters.");
          return;
        }

        if (password !== confirmPassword) {
          event.preventDefault();
          alert("Account passwords do not match.");
          return;
        }
      }

      if (cartDataInput) {
        cartDataInput.value = JSON.stringify(cart);
      }
    });
  }

  checkoutModeInputs.forEach((input) => {
    input.addEventListener("change", renderCheckoutMode);
  });

  document.querySelectorAll(".checkout-add-to-cart").forEach((button) => {
    button.addEventListener("click", () => {
      const itemId = String(button.getAttribute("data-item-id") || "");
      const cardBody = button.closest(".item-card-body");
      const piecesInput = cardBody ? cardBody.querySelector(".checkout-piece-input") : null;
      const pieces = piecesInput ? Number(piecesInput.value) : 1;

      addItemFromCheckoutShop(itemId, pieces);

      if (piecesInput) {
        piecesInput.value = "1";
      }
    });
  });

  document.querySelectorAll(".checkout-piece-input").forEach((input) => {
    input.addEventListener("change", () => {
      const max = Number(input.getAttribute("max")) || 1;
      let value = Number(input.value);

      if (!Number.isInteger(value) || value < 1) {
        value = 1;
      }

      if (value > max) {
        value = max;
      }

      input.value = String(value);
    });
  });

  if (checkoutShopSearch) {
    checkoutShopSearch.addEventListener("input", filterCheckoutShopItems);
  }

  if (checkoutShopCategory) {
    checkoutShopCategory.addEventListener("change", filterCheckoutShopItems);
  }

  applyDirectBuyFromQuery();
  renderCheckoutMode();
  filterCheckoutShopItems();
  initializeLocationSelectors();
  updateHiddenLocationFields();
  render();
})();
