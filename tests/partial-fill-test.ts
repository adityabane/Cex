import { prisma } from "../apps/engine/db";

const API = "http://localhost:3000";

async function request(
  path: string,
  options: RequestInit = {},
) {
  const res = await fetch(`${API}${path}`, options);
  const text = await res.text();

  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} -> ${res.status}: ${text}`,
    );
  }

  return data;
}

async function createUser() {
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
) {
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
  side: "BUY" | "SELL",
  qty: number,
  price: number,
) {
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
  expectedStatuses: string[],
  timeoutMs = 10000,
  intervalMs = 200,
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const order = await prisma.order.findUnique({
      where: {
        id: orderId,
      },
    });

    if (order && expectedStatuses.includes(order.status)) {
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
    `Order ${orderId} did not reach [${expectedStatuses.join(
      ", ",
    )}] within ${timeoutMs}ms. Current status: ${
      finalOrder?.status ?? "NOT_FOUND"
    }`,
  );
}
async function main() {
  console.log("\nPARTIAL FILL TEST\n");

  /*
   * Create users
   */

  const buyer = await createUser();
  const seller = await createUser();

  console.log("Buyer:", buyer.id);
  console.log("Seller:", seller.id);

  /*
   * Create balances
   *
   * Buyer:
   *   5000 USDT
   *
   * Seller:
   *   1 ETH
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
   * Create resting SELL:
   *
   * SELL 0.4 ETH @ 2000
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
   * Wait for the Redis consumer to process
   * the SELL order before creating the BUY.
   */

  await Bun.sleep(1500);

  /*
   * Create BUY:
   *
   * BUY 1 ETH @ 2000
   *
   * Expected:
   *
   *   Trade = 0.4 ETH
   *   SELL = FILLED
   *   BUY  = PARTIALLY_FILLED
   *   BUY remaining = 0.6 ETH
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
   * Wait for matching.
   */

 

  /*
   * Read directly from PostgreSQL.
   *
   * We intentionally do not use GET /orders/:orderId here.
   * That endpoint has ownership authorization and is not needed
   * to test the matching engine itself.
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
console.log("BUY:", buyOrder.status);
console.log("SELL:", sellOrder.status);

  /*
   * Verify order states.
   */

  if (buyOrder.status !== "PARTIALLY_FILLED") {
    throw new Error(
      `Expected BUY PARTIALLY_FILLED, got ${buyOrder.status}`,
    );
  }

  if (sellOrder.status !== "FILLED") {
    throw new Error(
      `Expected SELL FILLED, got ${sellOrder.status}`,
    );
  }

  /*
   * Verify remaining quantity.
   */

  const remainingQty = Number(buyOrder.remainingQty);

  if (Math.abs(remainingQty - 0.6) > 1e-9) {
    throw new Error(
      `Expected BUY remainingQty = 0.6, got ${remainingQty}`,
    );
  }

  /*
   * Get final balances directly from Prisma.
   */

  const buyerETH = await prisma.balance.findUnique({
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

  const sellerETH = await prisma.balance.findUnique({
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

  console.log("\nFINAL BALANCES");

  console.log("Buyer ETH:", buyerETH);
  console.log("Buyer USDT:", buyerUSDT);
  console.log("Seller ETH:", sellerETH);
  console.log("Seller USDT:", sellerUSDT);

  if (!buyerETH || !buyerUSDT || !sellerETH || !sellerUSDT) {
    throw new Error("One or more expected balances are missing");
  }

  /*
   * Expected settlement:
   *
   * Buyer:
   *   ETH  +0.4
   *   USDT -800
   *
   * Seller:
   *   ETH  -0.4
   *   USDT +800
   */

  const buyerEthAvailable = Number(buyerETH.available);
  const buyerUsdtAvailable = Number(buyerUSDT.available);

  const sellerEthAvailable = Number(sellerETH.available);
  const sellerUsdtAvailable = Number(sellerUSDT.available);

  if (Math.abs(buyerEthAvailable - 0.4) > 1e-9) {
    throw new Error(
      `Buyer ETH incorrect: ${buyerEthAvailable}`,
    );
  }

  if (Math.abs(buyerUsdtAvailable - 4200) > 1e-9) {
    throw new Error(
      `Buyer USDT incorrect: ${buyerUsdtAvailable}`,
    );
  }

  if (Math.abs(sellerEthAvailable - 0.6) > 1e-9) {
    throw new Error(
      `Seller ETH incorrect: ${sellerEthAvailable}`,
    );
  }

  if (Math.abs(sellerUsdtAvailable - 800) > 1e-9) {
    throw new Error(
      `Seller USDT incorrect: ${sellerUsdtAvailable}`,
    );
  }

  /*
   * Verify exactly one trade was created
   * for this pair of orders.
   */

  const trades = await prisma.trade.findMany({
    where: {
      OR: [
        {
          buyOrderId: buy.orderId,
          sellOrderId: sell.orderId,
        },
        {
          buyOrderId: sell.orderId,
          sellOrderId: buy.orderId,
        },
      ],
    },
  });

  console.log("\nTRADES:");
  console.log(trades);

  if (trades.length !== 1) {
    throw new Error(
      `Expected exactly 1 trade, got ${trades.length}`,
    );
  }

  const trade = trades[0];
  if(trade===undefined){
    throw new Error("Trade is undefined")
  }
  const tradeQty = Number(trade.quantity);
  const tradePrice = Number(trade.price);

  if (Math.abs(tradeQty - 0.4) > 1e-9) {
    throw new Error(
      `Expected trade quantity 0.4, got ${tradeQty}`,
    );
  }

  if (Math.abs(tradePrice - 2000) > 1e-9) {
    throw new Error(
      `Expected trade price 2000, got ${tradePrice}`,
    );
  }

  console.log("\nPARTIAL FILL PASSED");

  console.log("Verified:");
  console.log("SELL 0.4 ETH @ 2000");
  console.log("BUY 1 ETH @ 2000");
  console.log("Exactly one trade created");
  console.log("Trade quantity = 0.4 ETH");
  console.log("Trade price = 2000");
  console.log("BUY = PARTIALLY_FILLED");
  console.log("SELL = FILLED");
  console.log("BUY remaining quantity = 0.6 ETH");
  console.log("Buyer received 0.4 ETH");
  console.log("Buyer paid 800 USDT");
  console.log("Seller received 800 USDT");
  console.log("Seller remaining ETH = 0.6");
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


