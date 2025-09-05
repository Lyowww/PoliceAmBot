const axios = require("axios").default;
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const TelegramBot = require("node-telegram-bot-api");

const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

// Telegram setup
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true }); // polling enabled for /try

const BASE_URL = "https://roadpolice.am";
const LOGIN_URL = `${BASE_URL}/hy/hqb-sw/login`;
const NEAREST_URL = `${BASE_URL}/hy/hqb-nearest-day`;
const PROFILE_URL = `${BASE_URL}/hy/hqb-profile`;

const loginData = {
    psn: process.env.PSN,
    phone_number: process.env.PHONE_NUMBER,
    country: "374",
    login_type: "hqb"
};

const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 60 * 60 * 1000;
let isLoggedIn = false;
let xsrfToken = null;
let paused = false; // 🔹 new flag

// Function to check if error is temporary service unavailability
function isTemporaryServiceError(error) {
    const errorData = error.response?.data || error;

    if (errorData.error === 'Հերթի ծառայությունը ժամանակավորապես անհասանելի է։ Խնդրում ենք փորձել ավելի ուշ') {
        return true;
    }
    if (errorData.message === 'Server Error') {
        return true;
    }

    const errorString = JSON.stringify(errorData).toLowerCase();
    if (errorString.includes('temporary') || errorString.includes('unavailable') ||
        errorString.includes('service') || errorString.includes('server')) {
        return true;
    }

    return false;
}

function parseDate(d) {
    const [day, month, year] = d.split("-").map(Number);
    return new Date(year, month - 1, day);
}

function formatDateForAPI(date) {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

async function login() {
    try {
        await jar.removeAllCookies();
        await client.get(`${BASE_URL}/hy/hqb`);

        const cookies = await jar.getCookies(BASE_URL);
        const xsrfCookie = cookies.find(c => c.key === "XSRF-TOKEN");

        if (!xsrfCookie) throw new Error("Missing XSRF token cookie");

        xsrfToken = decodeURIComponent(xsrfCookie.value);
        console.log("XSRF Token:", xsrfToken);

        const payload = new URLSearchParams(loginData);

        const res = await client.post(LOGIN_URL, payload.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-XSRF-TOKEN": xsrfToken,
                "X-Requested-With": "XMLHttpRequest",
            }
        });

        if (res.data.status !== "OK") {
            throw new Error("Login failed: " + JSON.stringify(res.data));
        }

        isLoggedIn = true;
        console.log("✅ Successfully logged in");
        return xsrfToken;
    } catch (error) {
        isLoggedIn = false;
        xsrfToken = null;
        throw error;
    }
}

async function checkSessionValidity() {
    try {
        const res = await client.get(PROFILE_URL, {
            headers: { "X-Requested-With": "XMLHttpRequest" }
        });
        return res.status === 200;
    } catch {
        return false;
    }
}

async function ensureAuthenticated() {
    if (!isLoggedIn) {
        console.log("Not logged in, attempting login...");
        return await login();
    }
    try {
        const isValid = await checkSessionValidity();
        if (!isValid) {
            console.log("Session expired, re-logging in...");
            return await login();
        }
        return xsrfToken;
    } catch {
        console.log("Session check failed, re-logging in...");
        return await login();
    }
}

async function checkNearestDay() {
    const token = await ensureAuthenticated();

    const payload = new URLSearchParams();
    payload.append('branchId', '39');
    payload.append('serviceId', '300692');
    payload.append('date', '01-11-2025');

    console.log("📅 Requesting nearest day with date: 01-11-2025");

    try {
        const res = await client.post(NEAREST_URL, payload.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-XSRF-TOKEN": token,
                "X-Requested-With": "XMLHttpRequest",
            }
        });
        return res.data;
    } catch (error) {
        console.error("❌ Error in checkNearestDay:", error.response?.data || error.message);
        throw error;
    }
}

async function performCheck() {
    if (paused) {
        console.log("⏸️ Checks are paused, skipping...");
        return { status: 'paused', message: 'Checks paused' };
    }

    try {
        console.log("🔍 Starting check at", new Date().toISOString());

        const result = await checkNearestDay();
        console.log("📅 Result:", JSON.stringify(result, null, 2));

        // 🔹 Handle daily limit
        if (result.status === "ERROR" && result.error?.includes('սահմանաչափը սպառված է')) {
            paused = true;
            console.log("⚠️ Daily limit reached, pausing until /try command");
            await bot.sendMessage(CHAT_ID, "⚠️ Օրվա հարցումների սահմանաչափը սպառվել է։ Ստուգումները կանգնեցվեցին։ Գրիր /try վերագործարկելու համար։");
            return { status: 'limit_reached', message: 'Daily limit reached, bot paused' };
        }

        if (result.status === "OK" && result.data?.day) {
            const nearest = result.data.day;
            const slots = result.data.slots || [];
            console.log("🚨 Nearest date found:", nearest);
            console.log("📋 Available slots:", slots.length);

            const targetDate = new Date(2025, 10, 1);
            const nearestDate = parseDate(nearest);

            if (nearestDate <= targetDate) {
                const message = `🚨 Nearest date available: ${nearest}\nAvailable slots: ${slots.length}\nFirst slot: ${slots[0]?.value || 'N/A'}`;
                await bot.sendMessage(CHAT_ID, message);
                return { status: 'success', message: 'Notification sent', date: nearest, slots: slots };
            } else {
                console.log("No suitable date found. Nearest:", nearest);
                return { status: 'no_change', message: 'No suitable date', date: nearest };
            }
        }

        return { status: 'no_data', message: 'No date data received', data: result };

    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);

        if (isTemporaryServiceError(err)) {
            return { status: 'temporary_error', message: 'Temporary service unavailability' };
        }

        isLoggedIn = false;
        xsrfToken = null;
        return { status: 'error', message: err.response?.data || err.message };
    }
}

async function checkNearestDayAlternative() {
    try {
        const token = await ensureAuthenticated();
        const payload = new URLSearchParams();
        payload.append('branchId', '39');
        payload.append('serviceId', '300692');
        payload.append('date', '2025-09-01');

        console.log("📅 Alternative: YYYY-MM-DD format");

        const res = await client.post(NEAREST_URL, payload.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-XSRF-TOKEN": token,
                "X-Requested-With": "XMLHttpRequest",
            }
        });
        return res.data;
    } catch (error) {
        console.log("❌ Alternative failed:", error.response?.data || error.message);
        return null;
    }
}

// HTTP endpoint for manual triggering
module.exports = async (req, res) => {
    try {
        const result = await performCheck();
        return res.status(result.status === 'error' ? 500 : 200).json(result);
    } catch (err) {
        if (isTemporaryServiceError(err)) {
            return res.status(200).json({ status: 'temporary_error', message: 'Temporary service unavailability' });
        }
        return res.status(500).json({ status: 'error', message: 'Unexpected error: ' + err.message });
    }
};

// 🔹 Telegram command handler
bot.onText(/\/try/, async (msg) => {
    if (msg.chat.id.toString() !== CHAT_ID) return;
    if (paused) {
        paused = false;
        await bot.sendMessage(CHAT_ID, "✅ Ստուգումները վերագործարկվեցին։");
        performCheck(); // run one immediately
    } else {
        await bot.sendMessage(CHAT_ID, "ℹ️ Ստուգումները արդեն ակտիվ են։");
    }
});

// Start scheduled checks
if (require.main === module) {
    console.log("🚀 Starting Road Police Checker with scheduled checks");
    performCheck();
    setInterval(performCheck, CHECK_INTERVAL);

    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
}