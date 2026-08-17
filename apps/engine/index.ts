console.log("CEX v2 engine Started");
import {createAccount} from "./accounts";
const UserA = createAccount("A");
const UserB = createAccount("B");
UserA.balances.BTC.available=1000;
UserB.balances.BTC.available=700;
console.log(UserA);
console.log(UserB);