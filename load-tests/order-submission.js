
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

const ordersAccepted = new Counter("orders_accepted");

export const options = {
    stages: [
        { duration: "30s", target: 1 },
        { duration: "1m", target: 5 },
        { duration: "1m", target: 10 },
        { duration: "30s", target: 0 },
    ],

    thresholds: {
        http_req_failed: ["rate<0.01"],
        http_req_duration: ["p(95)<1000"],
    },
};

export function setup() {
    const runId = `${Date.now()}`;
    const email = `loadtest-${runId}@example.com`;
    const password = `LoadTestOnly-${runId}!`;
    const asset = `LOADTEST${runId}`;

    const jsonHeaders = {
        headers: {
            "Content-Type": "application/json",
        },
    };

    // Create a dedicated user for this test run.
    const userResponse = http.post(
        `${BASE_URL}/users`,
        JSON.stringify({ email, password }),
        jsonHeaders,
    );

    check(userResponse, {
        "test user created": (r) => r.status === 201,
    });

    if (userResponse.status !== 201) {
        throw new Error(
            `User creation failed: ${userResponse.status} ${userResponse.body}`,
        );
    }

    const user = userResponse.json();

    // Authenticate the dedicated test user.
    const loginResponse = http.post(
        `${BASE_URL}/auth/login`,
        JSON.stringify({ email, password }),
        jsonHeaders,
    );

    check(loginResponse, {
        "test user login succeeded": (r) => r.status === 200,
    });

    if (loginResponse.status !== 200) {
        throw new Error(
            `Login failed: ${loginResponse.status} ${loginResponse.body}`,
        );
    }

    const login = loginResponse.json();

    const authHeaders = {
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${login.token}`,
        },
    };

    // Fund the account for BUY LIMIT orders.
    const balanceResponse = http.post(
        `${BASE_URL}/users/${user.id}/balances`,
        JSON.stringify({
            asset: "USDT",
            amount: 1000000,
        }),
        authHeaders,
    );

    check(balanceResponse, {
        "test balance created": (r) => r.status === 201,
    });

    if (balanceResponse.status !== 201) {
        throw new Error(
            `Balance creation failed: ${balanceResponse.status} ${balanceResponse.body}`,
        );
    }

    console.log(`Load-test user ID: ${user.id}`);
    console.log(`Load-test asset: ${asset}`);

    return {
        userId: user.id,
        token: login.token,
        asset,
    };
}

export default function (data) {
    const response = http.post(
        `${BASE_URL}/orders`,
        JSON.stringify({
            asset: data.asset,
            side: "BUY",
            type: "LIMIT",
            qty: 0.001,
            price: 1,
        }),
        {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${data.token}`,
            },
        },
    );

    const validResponse = check(response, {
        "order accepted with HTTP 201": (r) => r.status === 201,
        "response contains orderId": (r) => {
            if (r.status !== 201) return false;

            try {
                return Boolean(r.json("orderId"));
            } catch {
                return false;
            }
        },
    });

    if (validResponse && response.status === 201) {
        ordersAccepted.add(1);
    }
}
