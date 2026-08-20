console.log("CEX v2 engine Started");
import {createAccount} from "./accounts";
import {CreateOrder} from "./order";
const UserA = createAccount("A");
const UserB = createAccount("B");
UserA.balances.BTC.available=1000;
UserB.balances.BTC.available=700;
const order = CreateOrder("order-1",UserA.id,"BUY",1,100);
console.log(UserA);
console.log(UserB);
console.log(order)