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

// Function to check if error is temporary service unavailability
function isTemporaryServiceError(error) {
    const errorData = error.response?.data || error;
    
    // Check for Armenian temporary service error message
    if (errorData.error === 'Հերթի ծառայությունը ժամանակավորապես անհասանելի է։ Խնդրում ենք փորձել ավելի ուշ') {
        return true;
    }
    
    // Check for English server error message
    if (errorData.message === 'Server Error') {
        return true;
    }
    
    // Check if error contains temporary service keywords
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
        // Clear existing cookies first to prevent "already authenticated" error
        await jar.removeAllCookies();
        
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

async function checkSessionValidity() {
    try {
        // Use a lightweight endpoint to check if session is still valid
        const res = await client.get(PROFILE_URL, {
            headers: {
                "X-Requested-With": "XMLHttpRequest",
            }
        });
        
        // If we get a valid response, session is still good
        return res.status === 200;
    } catch (error) {
        // If we get an unauthorized error, session is invalid
        return false;
    }
}

async function ensureAuthenticated() {
    if (!isLoggedIn) {
        console.log("Not logged in, attempting login...");
        return await login();
    }
    
    // Verify session is still valid
    try {
        const isValid = await checkSessionValidity();
        if (!isValid) {
            console.log("Session expired, re-logging in...");
            return await login();
        }
        return xsrfToken;
    } catch (error) {
        console.log("Session check failed, re-logging in...");
        return await login();
    }
}

async function checkNearestDay() {
    const token = await ensureAuthenticated();
    
    // Try different date formats - the API might expect a specific format
    // Option 1: Try with empty date (let server determine)
    // Option 2: Try with a future date
    // Option 3: Try with specific format
    
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30); // 30 days from now
    
    const payload = new URLSearchParams({
        branchId: "39",
        serviceId: "300692",
        date: "" // Try with empty date first
    });

    console.log("📅 Requesting nearest day with empty date");

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
        // If empty date fails, try with a future date
        if (error.response?.data?.status === "INVALID_DATA") {
            console.log("⚠️ Empty date failed, trying with future date...");
            
            const formattedDate = formatDateForAPI(futureDate);
            payload.set("date", formattedDate);
            
            console.log("📅 Requesting nearest day with future date:", formattedDate);
            
            const res2 = await client.post(NEAREST_URL, payload.toString(), {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-XSRF-TOKEN": token,
                    "X-Requested-With": "XMLHttpRequest",
                }
            });
            
            return res2.data;
        }
        throw error;
    }
}

// Function to perform the check and send notification if needed
async function performCheck() {
    try {
        console.log("🔍 Starting check at", new Date().toISOString());
        
        const result = await checkNearestDay();
        console.log("📅 Result:", JSON.stringify(result, null, 2));

        if (result.status === "OK" && result.data?.day) {
            const nearest = result.data.day;
            const slots = result.data.slots || [];
            console.log("🚨 Nearest date found:", nearest);
            console.log("📋 Available slots:", slots.length);

            const targetDate = new Date(2025, 9, 1); // October 1st, 2025 (month is 0-indexed)
            const nearestDate = parseDate(nearest);
            
            if (nearestDate <= targetDate) {
                const message = `🚨 Nearest date available: ${nearest}\nAvailable slots: ${slots.length}\nFirst slot: ${slots[0]?.value || 'N/A'}`;
                console.log("🚨 Sending message:", message);
                await bot.sendMessage(CHAT_ID, message);
                return { 
                    status: 'success', 
                    message: 'Notification sent',
                    date: nearest,
                    slots: slots
                };
            } else {
                console.log("No suitable date found yet. Nearest is:", nearest, "Target is:", formatDateForAPI(targetDate));
                return { 
                    status: 'no_change', 
                    message: 'No suitable date found',
                    date: nearest,
                    target: formatDateForAPI(targetDate)
                };
            }
        } else if (result.status === "INVALID_DATA") {
            console.log("⚠️ Invalid data error, checking error details:", result.errors);
            
            // Try one more approach - maybe the API expects a specific date format
            console.log("🔄 Trying alternative approach...");
            const alternativeResult = await checkNearestDayAlternative();
            if (alternativeResult) {
                return alternativeResult;
            }
            
            return { 
                status: 'invalid_data', 
                message: 'Invalid data provided to API',
                errors: result.errors
            };
        }
        
        return { 
            status: 'no_data', 
            message: 'No date data received',
            data: result
        };
    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
        
        // Check if this is a temporary service error
        if (isTemporaryServiceError(err)) {
            console.log("⚠️ Temporary service error, not sending Telegram notification");
            return { 
                status: 'temporary_error', 
                message: 'Temporary service unavailability',
                error: err.response?.data || err.message
            };
        }
        
        // Reset login state on error
        isLoggedIn = false;
        xsrfToken = null;
        
        return { 
            status: 'error', 
            message: err.response?.data || err.message
        };
    }
}

// Alternative approach for checking nearest day
async function checkNearestDayAlternative() {
    try {
        const token = await ensureAuthenticated();
        
        // Try with a very specific date format that might work
        const payload = new URLSearchParams({
            branchId: "39",
            serviceId: "300692",
            date: "2025-09-01" // Try YYYY-MM-DD format
        });

        console.log("📅 Alternative: Requesting with YYYY-MM-DD format");

        const res = await client.post(NEAREST_URL, payload.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-XSRF-TOKEN": token,
                "X-Requested-With": "XMLHttpRequest",
            }
        });

        return res.data;
    } catch (error) {
        console.log("❌ Alternative approach also failed:", error.response?.data || error.message);
        return null;
    }
}

// HTTP endpoint for manual triggering and Railway health checks
module.exports = async (req, res) => {
    try {
        const result = await performCheck();
        return res.status(result.status === 'error' ? 500 : 200).json(result);
    } catch (err) {
        console.error("Unexpected error in HTTP handler:", err);
        
        // Check if this is a temporary service error
        if (isTemporaryServiceError(err)) {
            return res.status(200).json({ 
                status: 'temporary_error', 
                message: 'Temporary service unavailability'
            });
        }
        
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
