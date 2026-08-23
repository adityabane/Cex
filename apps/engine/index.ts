console.log("CEX v2 engine Started");
import {createAccount} from "./accounts";
import {CreateOrder,lockMarketBuyBalance,LockOrderBalance} from "./order";
import {Orderbook} from "./order-book";
console.log("\n==============================");
console.log("      CEX V2 ENGINE TEST");
console.log("==============================\n");

// --------------------------------------------------
// 1. CREATE ACCOUNTS
// --------------------------------------------------

const buyer = createAccount("buyer");
const seller = createAccount("seller");

buyer.balances.USDT.available = 1000;
seller.balances.BTC.available = 5;

console.log("Initial balances:");
console.log("Buyer:", buyer);
console.log("Seller:", seller);


// --------------------------------------------------
// 2. CREATE ACCOUNT MAP
// --------------------------------------------------

const accounts = new Map([
  [buyer.id, buyer],
  [seller.id, seller],
]);

const orderBook = new Orderbook(accounts);


// --------------------------------------------------
// 3. LIMIT ORDER TEST
// --------------------------------------------------

console.log("\n==============================");
console.log("TEST 1: LIMIT ORDER");
console.log("==============================");

const buyOrder = CreateOrder(
  "order-1",
  buyer.id,
  "BUY",
  "LIMIT",
  2,
  100
);

const sellOrder = CreateOrder(
  "order-2",
  seller.id,
  "SELL",
  "LIMIT",
  2,
  100
);

console.log("\nCreated orders:");
console.log("Buy:", buyOrder);
console.log("Sell:", sellOrder);


// --------------------------------------------------
// 4. LOCK BALANCES
// --------------------------------------------------

LockOrderBalance(buyer, buyOrder);
LockOrderBalance(seller, sellOrder);

console.log("\nBalances after locking:");
console.log("Buyer:", buyer);
console.log("Seller:", seller);


// --------------------------------------------------
// 5. ADD TO ORDER BOOK
// --------------------------------------------------

orderBook.add(buyOrder);
orderBook.add(sellOrder);

console.log("\nOrder book before matching:");
console.log("BIDS:", orderBook.getBids());
console.log("ASKS:", orderBook.getAsks());


// --------------------------------------------------
// 6. MATCH
// --------------------------------------------------

console.log("\nMatching...");

orderBook.match();

console.log("\nOrder book after matching:");
console.log("BIDS:", orderBook.getBids());
console.log("ASKS:", orderBook.getAsks());


// --------------------------------------------------
// 7. CHECK SETTLEMENT
// --------------------------------------------------

console.log("\nBalances after settlement:");

console.log("Buyer:");
console.log("BTC:", buyer.balances.BTC);
console.log("USDT:", buyer.balances.USDT);

console.log("\nSeller:");
console.log("BTC:", seller.balances.BTC);
console.log("USDT:", seller.balances.USDT);


// --------------------------------------------------
// 8. PARTIAL FILL TEST
// --------------------------------------------------

console.log("\n==============================");
console.log("TEST 2: PARTIAL FILL");
console.log("==============================");

const partialBuy = CreateOrder(
  "order-3",
  buyer.id,
  "BUY",
  "LIMIT",
  3,
  90
);

const partialSell = CreateOrder(
  "order-4",
  seller.id,
  "SELL",
  "LIMIT",
  1,
  90
);

LockOrderBalance(buyer, partialBuy);
LockOrderBalance(seller, partialSell);

orderBook.add(partialBuy);
orderBook.add(partialSell);

console.log("\nBefore matching:");

console.log("BIDS:");
console.log(orderBook.getBids());

console.log("ASKS:");
console.log(orderBook.getAsks());

console.log("\nMatching...");

orderBook.match();

console.log("\nAfter matching:");

console.log("BIDS:");
console.log(orderBook.getBids());

console.log("ASKS:");
console.log(orderBook.getAsks());


// --------------------------------------------------
// 9. MARKET BUY TEST
// --------------------------------------------------

console.log("\n==============================");
console.log("TEST 3: MARKET BUY");
console.log("==============================");

// Create sellers for market-buy liquidity

const seller2 = createAccount("seller-2");

seller2.balances.BTC.available = 3;

accounts.set(seller2.id, seller2);

const ask1 = CreateOrder(
  "order-5",
  seller2.id,
  "SELL",
  "LIMIT",
  1,
  100
);

const ask2 = CreateOrder(
  "order-6",
  seller2.id,
  "SELL",
  "LIMIT",
  2,
  101
);

LockOrderBalance(seller2, ask1);
LockOrderBalance(seller2, ask2);

orderBook.add(ask1);
orderBook.add(ask2);

console.log("\nOrder book before market BUY:");

console.log("BIDS:");
console.log(orderBook.getBids());

console.log("ASKS:");
console.log(orderBook.getAsks());


// Market BUY for 3 BTC

const marketBuy = CreateOrder(
  "order-7",
  buyer.id,
  "BUY",
  "MARKET",
  3
);

const requiredUsdt =
  orderBook.getMarketBuyCost(marketBuy.qty);

console.log("\nMarket BUY requires:");
console.log(requiredUsdt, "USDT");

lockMarketBuyBalance(
  buyer,
  marketBuy,
  requiredUsdt
);

// Add market order and match
console.log("\nMatching market BUY...");

orderBook.executeMarketOrder(marketBuy);


// --------------------------------------------------
// 10. FINAL BALANCES
// --------------------------------------------------

console.log("\n==============================");
console.log("FINAL BALANCES");
console.log("==============================");

console.log("\nBuyer:");
console.log(buyer);

console.log("\nSeller:");
console.log(seller);

console.log("\nSeller 2:");
console.log(seller2);


// --------------------------------------------------
// 11. FINAL ORDER BOOK
// --------------------------------------------------

console.log("\n==============================");
console.log("FINAL ORDER BOOK");
console.log("==============================");

console.log("\nBIDS:");
console.log(orderBook.getBids());

console.log("\nASKS:");
console.log(orderBook.getAsks());

console.log("\n==============================");
console.log("       TEST COMPLETE");
console.log("==============================\n");