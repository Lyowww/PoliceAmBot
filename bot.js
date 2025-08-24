// api/check.js
const axios = require("axios").default;
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const TelegramBot = require("node-telegram-bot-api");

const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

// Telegram setup
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

const BASE_URL = "https://roadpolice.am";
const LOGIN_URL = `${BASE_URL}/hy/hqb-sw/login`;
const NEAREST_URL = `${BASE_URL}/hy/hqb-nearest-day`;

const loginData = {
    psn: process.env.PSN,         
    phone_number: process.env.PHONE_NUMBER,  
    country: "374",
    login_type: "hqb"
};

function parseDate(d) {
    const [day, month, year] = d.split("-").map(Number);
    return new Date(year, month - 1, day);
}

async function login() {
    await client.get("https://roadpolice.am/hy/hqb");

    const cookies = await jar.getCookies(BASE_URL);
    const xsrf = cookies.find(c => c.key === "XSRF-TOKEN");
    const session = cookies.find(c => c.key.includes("session"));

    if (!xsrf || !session) throw new Error("Missing XSRF or session cookie");
    const token = decodeURIComponent(xsrf.value);

    const payload = new URLSearchParams(loginData);

    const res = await client.post(LOGIN_URL, payload.toString(), {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-XSRF-TOKEN": token,
            "X-Requested-With": "XMLHttpRequest",
        }
    });

    if (res.data.status !== "OK") throw new Error("Login failed: " + JSON.stringify(res.data));
    return token;
}

async function checkNearestDay(token) {
    const payload = new URLSearchParams({
        branchId: "39",
        serviceId: "300692",
        date: "01-09-2025"
    });

    const res = await client.post(NEAREST_URL, payload.toString(), {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-XSRF-TOKEN": token,
            "X-Requested-With": "XMLHttpRequest",
        }
    });

    return res.data;
}

module.exports = async (req, res) => {
    try {
        const token = await login();
        console.log("✅ Logged in");

        const result = await checkNearestDay(token);
        console.log("📅 Result:", result);

        if (result.status === "OK" && result.data?.day) {
            const nearest = result.data.day;
            console.log("🚨 Nearest date found:", nearest);

            // Check if date is before November 10, 2025
            const targetDate = new Date(2025, 10, 10); // November is month 10 (0-indexed)
            const nearestDate = parseDate(nearest);
            
            if (nearestDate <= targetDate) {
                console.log("🚨 Sending message", nearest);
                await bot.sendMessage(CHAT_ID, `🚨 Nearest date available: ${nearest}`);
                return res.status(200).json({ 
                    status: 'success', 
                    message: 'Notification sent',
                    date: nearest
                });
            } else {
                console.log("No suitable date found yet. Nearest is:", nearest);
                return res.status(200).json({ 
                    status: 'no_change', 
                    message: 'No suitable date found',
                    date: nearest
                });
            }
        }
        
        return res.status(200).json({ 
            status: 'no_data', 
            message: 'No date data received'
        });
    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
        return res.status(500).json({ 
            status: 'error', 
            message: err.response?.data || err.message
        });
    }
};