console.log("CEX v2 engine Started");
import {createAccount} from "./accounts";
import {CreateOrder,LockOrderBalance} from "./order";
const userA = createAccount("user-a");
userA.balances.USDT.available = 1000;
const buyOrder = CreateOrder(
  "order-1",
  userA.id,
  "BUY",
  1,
  100
);
console.log("Before locking:");
console.log(userA);
LockOrderBalance(userA, buyOrder);
console.log("After locking:");
console.log(userA);

const userB = createAccount("user-b");
userB.balances.BTC.available = 1;
const sellOrder = CreateOrder(
  "order-2",
  userB.id,
  "SELL",
  1,
  100
);
console.log("Before locking:");
console.log(userB);
LockOrderBalance(userB, sellOrder);
console.log("After locking:");
console.log(userB);