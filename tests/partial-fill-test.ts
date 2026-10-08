import { prisma } from "../apps/engine/db";

const API = "http://localhost:3000";

type OrderSide = "BUY" | "SELL";

type OrderStatus =
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED";

type Order = {
  id: string;
  userId: string;
  side: string;
  type: string;
  asset: string;
  quantity: unknown;
  remainingQty: unknown;
  price: unknown;
  status: string;
};

type User = {
  id: string;
  token: string;
};

async function request(
  path: string,
  options: RequestInit = {},
): Promise<any> {
  const response = await fetch(`${API}${path}`, options);
  const text = await response.text();

  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`,
    );
  }

  return data;
}

async function createUser(): Promise<User> {
  const unique = crypto.randomUUID();

  const email = `partial-${unique}@test.com`;
  const password = "password123";

  const user = await request("/users", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
    }),
  });

  const login = await request("/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
    }),
  });

  return {
    id: user.id,
    token: login.token,
  };
}

async function createBalance(
  userId: string,
  token: string,
  asset: string,
  amount: number,
): Promise<void> {
  await request(`/users/${userId}/balances`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      asset,
      amount,
    }),
  });
}

async function createOrder(
  token: string,
  asset: string,
  side: OrderSide,
  qty: number,
  price: number,
): Promise<{ orderId: string }> {
  return request("/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      asset,
      side,
      type: "LIMIT",
      qty,
      price,
    }),
  });
}

async function waitForOrderState(
  orderId: string,
  expectedStatuses: OrderStatus[],
  timeoutMs = 10000,
  intervalMs = 200,
): Promise<Order> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const order = await prisma.order.findUnique({
      where: {
        id: orderId,
      },
    });

    if (
      order &&
      expectedStatuses.includes(order.status as OrderStatus)
    ) {
      return order;
    }

    await Bun.sleep(intervalMs);
  }

  const finalOrder = await prisma.order.findUnique({
    where: {
      id: orderId,
    },
  });

  throw new Error(
    `Order ${orderId} did not reach expected state [${expectedStatuses.join(
      ", ",
    )}] within ${timeoutMs}ms. Current state: ${
      finalOrder
        ? `${finalOrder.status}, remainingQty=${finalOrder.remainingQty}`
        : "NOT_FOUND"
    }`,
  );
}

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  console.log("\nPARTIAL FILL TEST\n");

  /*
   * --------------------------------------------------
   * 1. CREATE USERS
   * --------------------------------------------------
   */

  const buyer = await createUser();
  const seller = await createUser();

  console.log("Buyer:", buyer.id);
  console.log("Seller:", seller.id);

  /*
   * --------------------------------------------------
   * 2. CREATE BALANCES
   *
   * Buyer:
   *   5000 USDT
   *
   * Seller:
   *   1 XRP
   * --------------------------------------------------
   */

  await createBalance(
    buyer.id,
    buyer.token,
    "USDT",
    5000,
  );

  await createBalance(
    seller.id,
    seller.token,
    "XRP",
    1,
  );

  console.log("Balances created.");

  /*
   * --------------------------------------------------
   * 3. CREATE RESTING SELL
   *
   * SELL 0.4 XRP @ 2000
   * --------------------------------------------------
   */

  const sell = await createOrder(
    seller.token,
    "XRP",
    "SELL",
    0.4,
    2000,
  );

  console.log("SELL order:", sell.orderId);

  /*
   * The REST API only queues the order.
   *
   * Wait until the Redis consumer has created the
   * actual PostgreSQL order and it is resting in the
   * order book.
   */

  const restingSell = await waitForOrderState(
    sell.orderId,
    ["OPEN"],
  );

  assert(
    restingSell.status === "OPEN",
    `SELL should be OPEN before BUY creation, got ${restingSell.status}`,
  );

  console.log("SELL reached OPEN state.");

  /*
   * --------------------------------------------------
   * 4. CREATE BUY
   *
   * BUY 1 XRP @ 2000
   *
   * Expected match:
   *
   *   0.4 XRP @ 2000
   *
   * Result:
   *
   *   BUY  = PARTIALLY_FILLED
   *   SELL = FILLED
   * --------------------------------------------------
   */

  const buy = await createOrder(
    buyer.token,
    "XRP",
    "BUY",
    1,
    2000,
  );

  console.log("BUY order:", buy.orderId);

  /*
   * --------------------------------------------------
   * 5. WAIT FOR MATCHING
   * --------------------------------------------------
   *
   * The matching pipeline is asynchronous:
   *
   * REST
   *   ↓
   * Redis
   *   ↓
   * Redis consumer
   *   ↓
   * PostgreSQL
   *   ↓
   * Matching engine
   *   ↓
   * Trade + settlement
   *
   * Therefore we poll for the actual database state
   * instead of using a fixed sleep.
   */

  const buyOrder = await waitForOrderState(
    buy.orderId,
    ["PARTIALLY_FILLED"],
  );

  const sellOrder = await waitForOrderState(
    sell.orderId,
    ["FILLED"],
  );

  console.log("\nMATCHING COMPLETED");
  console.log("BUY status:", buyOrder.status);
  console.log("SELL status:", sellOrder.status);

  /*
   * --------------------------------------------------
   * 6. VERIFY ORDER STATES
   * --------------------------------------------------
   */

  assert(
    buyOrder.status === "PARTIALLY_FILLED",
    `Expected BUY PARTIALLY_FILLED, got ${buyOrder.status}`,
  );

  assert(
    sellOrder.status === "FILLED",
    `Expected SELL FILLED, got ${sellOrder.status}`,
  );

  /*
   * --------------------------------------------------
   * 7. VERIFY REMAINING QUANTITY
   *
   * BUY:
   *
   *   Original = 1 XRP
   *   Filled   = 0.4 XRP
   *   Remaining = 0.6 XRP
   * --------------------------------------------------
   */

  const buyRemainingQty =
    Number(buyOrder.remainingQty);

  const sellRemainingQty =
    Number(sellOrder.remainingQty);

  assert(
    Math.abs(buyRemainingQty - 0.6) < 1e-9,
    `Expected BUY remainingQty = 0.6, got ${buyRemainingQty}`,
  );

  assert(
    Math.abs(sellRemainingQty - 0) < 1e-9,
    `Expected SELL remainingQty = 0, got ${sellRemainingQty}`,
  );

  /*
   * --------------------------------------------------
   * 8. READ FINAL BALANCES
   * --------------------------------------------------
   */

  const buyerXRP = await prisma.balance.findUnique({
    where: {
      userId_asset: {
        userId: buyer.id,
        asset: "XRP",
      },
    },
  });

  const buyerUSDT = await prisma.balance.findUnique({
    where: {
      userId_asset: {
        userId: buyer.id,
        asset: "USDT",
      },
    },
  });

  const sellerXRP = await prisma.balance.findUnique({
    where: {
      userId_asset: {
        userId: seller.id,
        asset: "XRP",
      },
    },
  });

  const sellerUSDT = await prisma.balance.findUnique({
    where: {
      userId_asset: {
        userId: seller.id,
        asset: "USDT",
      },
    },
  });

  assert(
    buyerXRP !== null,
    "Buyer XRP balance is missing",
  );

  assert(
    buyerUSDT !== null,
    "Buyer USDT balance is missing",
  );

  assert(
    sellerXRP !== null,
    "Seller XRP balance is missing",
  );

  assert(
    sellerUSDT !== null,
    "Seller USDT balance is missing",
  );

  console.log("\nFINAL BALANCES");

  console.log("Buyer XRP:", buyerXRP);
  console.log("Buyer USDT:", buyerUSDT);
  console.log("Seller XRP:", sellerXRP);
  console.log("Seller USDT:", sellerUSDT);

  /*
   * --------------------------------------------------
   * 9. VERIFY SETTLEMENT
   *
   * Trade:
   *
   *   0.4 XRP × 2000 USDT
   *   = 800 USDT
   *
   * Buyer:
   *
   *   USDT initial = 5000
   *   LIMIT BUY reservation = 2000
   *   Trade cost = 800
   *   Refund = 1200
   *   Available = 4200
   *
   *   XRP = 0.4
   *
   * Seller:
   *
   *   XRP initial = 1
   *   Sold = 0.4
   *   Remaining = 0.6
   *
   *   USDT = 800
   * --------------------------------------------------
   */

  const buyerXRPAvailable =
    Number(buyerXRP!.available);

  const buyerUSDTAvailable =
    Number(buyerUSDT!.available);

  const buyerUSDTLocked =
    Number(buyerUSDT!.locked);

  const sellerXRPAvailable =
    Number(sellerXRP!.available);

  const sellerXrpLocked =
    Number(sellerXRP!.locked);

  const sellerUSDTAvailable =
    Number(sellerUSDT!.available);

  assert(
    Math.abs(buyerXRPAvailable - 0.4) < 1e-9,
    `Buyer XRP incorrect: expected 0.4, got ${buyerXRPAvailable}`,
  );

  assert(
    Math.abs(buyerUSDTAvailable - 3000) < 1e-9,
    `Buyer USDT available incorrect: expected 3000, got ${buyerUSDTAvailable}`,
  );

  assert(
    Math.abs(buyerUSDTLocked - 1200) < 1e-9,
    `Buyer USDT locked incorrect: expected 1200, got ${buyerUSDTLocked}`,
  );

  assert(
    Math.abs(sellerXRPAvailable - 0.6) < 1e-9,
    `Seller XRP incorrect: expected 0.6, got ${sellerXRPAvailable}`,
  );

  assert(
    Math.abs(sellerXrpLocked - 0) < 1e-9,
    `Seller XRP locked incorrect: expected 0, got ${sellerXrpLocked}`,
  );

  assert(
    Math.abs(sellerUSDTAvailable - 800) < 1e-9,
    `Seller USDT incorrect: expected 800, got ${sellerUSDTAvailable}`,
  );

  /*
   * --------------------------------------------------
   * 10. VERIFY EXACTLY ONE TRADE
   * --------------------------------------------------
   */

  const trades = await prisma.trade.findMany({
    where: {
      buyOrderId: buy.orderId,
      sellOrderId: sell.orderId,
    },
  });

  console.log("\nTRADES:");
  console.log(trades);

  assert(
    trades.length === 1,
    `Expected exactly 1 trade, got ${trades.length}`,
  );

  const trade = trades[0];

  assert(
    trade !== undefined,
    "Expected trade record but received undefined",
  );

  /*
   * --------------------------------------------------
   * 11. VERIFY TRADE DETAILS
   * --------------------------------------------------
   */
  if(trade===undefined){
    throw new Error("trade is undefined")
  }
  const tradeQuantity =
    Number(trade.quantity);

  const tradePrice =
    Number(trade.price);

  assert(
    Math.abs(tradeQuantity - 0.4) < 1e-9,
    `Expected trade quantity 0.4, got ${tradeQuantity}`,
  );

  assert(
    Math.abs(tradePrice - 2000) < 1e-9,
    `Expected trade price 2000, got ${tradePrice}`,
  );

  /*
   * --------------------------------------------------
   * 12. SUCCESS
   * --------------------------------------------------
   */

  console.log("\nPARTIAL FILL PASSED");

  console.log("Verified:");
  console.log("SELL 0.4 XRP @ 2000");
  console.log("BUY 1 XRP @ 2000");
  console.log("Exactly one trade created");
  console.log("Trade quantity = 0.4 XRP");
  console.log("Trade price = 2000");
  console.log("BUY = PARTIALLY_FILLED");
  console.log("SELL = FILLED");
  console.log("BUY remaining quantity = 0.6 XRP");
  console.log("Buyer received 0.4 XRP");
  console.log("Buyer paid 800 USDT");
  console.log("Seller received 800 USDT");
  console.log("Seller remaining XRP = 0.6");
  console.log("No duplicate settlement");
}

main()
  .catch((error) => {
    console.error("\nPARTIAL FILL FAILED");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });