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

const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 60 * 60 * 1000;
let isLoggedIn = false;
let xsrfToken = null;

function parseDate(d) {
    const [day, month, year] = d.split("-").map(Number);
    return new Date(year, month - 1, day);
}

async function login() {
    try {
        // First get the initial page to set cookies
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

async function ensureAuthenticated() {
    if (!isLoggedIn) {
        console.log("Not logged in, attempting login...");
        return await login();
    }
    
    // Verify session is still valid by making a simple request
    try {
        // You might want to add a lightweight endpoint to check session validity
        return xsrfToken;
    } catch (error) {
        console.log("Session expired, re-logging in...");
        return await login();
    }
}

async function checkNearestDay() {
    const token = await ensureAuthenticated();
    
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

// Function to perform the check and send notification if needed
async function performCheck() {
    try {
        console.log("🔍 Starting check at", new Date().toISOString());
        
        const result = await checkNearestDay();
        console.log("📅 Result:", result);

        if (result.status === "OK" && result.data?.day) {
            const nearest = result.data.day;
            console.log("🚨 Nearest date found:", nearest);

            // Check if date is before November 10, 2025
            const targetDate = new Date(2025, 9, 3);// November is month 10 (0-indexed)
            const nearestDate = parseDate(nearest);
            
            if (nearestDate <= targetDate) {
                console.log("🚨 Sending message", nearest);
                await bot.sendMessage(CHAT_ID, `🚨 Nearest date available: ${nearest}`);
                return { 
                    status: 'success', 
                    message: 'Notification sent',
                    date: nearest
                };
            } else {
                console.log("No suitable date found yet. Nearest is:", nearest);
                return { 
                    status: 'no_change', 
                    message: 'No suitable date found',
                    date: nearest
                };
            }
        }
        
        return { 
            status: 'no_data', 
            message: 'No date data received'
        };
    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
        
        // Reset login state on error
        isLoggedIn = false;
        xsrfToken = null;
        
        // Send error notification to Telegram
        try {
            await bot.sendMessage(CHAT_ID, `❌ Error in road police check: ${err.message}`);
        } catch (telegramErr) {
            console.error("Failed to send Telegram error message:", telegramErr);
        }
        
        return { 
            status: 'error', 
            message: err.response?.data || err.message
        };
    }
}

// HTTP endpoint for manual triggering and Railway health checks
module.exports = async (req, res) => {
    try {
        const result = await performCheck();
        return res.status(result.status === 'error' ? 500 : 200).json(result);
    } catch (err) {
        console.error("Unexpected error in HTTP handler:", err);
        return res.status(500).json({ 
            status: 'error', 
            message: 'Unexpected error: ' + err.message
        });
    }
};

// Start scheduled checks if this is the main module
if (require.main === module) {
    console.log("🚀 Starting Road Police Checker with scheduled checks");
    
    // Perform initial check immediately
    performCheck();
    
    // Set up interval for repeated checks
    setInterval(performCheck, CHECK_INTERVAL);
    
    // Handle graceful shutdown
    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully');
        process.exit(0);
    });
    
    process.on('SIGINT', () => {
        console.log('Received SIGINT, shutting down gracefully');
        process.exit(0);
    });
}