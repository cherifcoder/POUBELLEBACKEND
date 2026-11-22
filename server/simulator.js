require('dotenv').config();

const API = 'http://localhost:3000';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.error('API_KEY manquante dans .env');
    process.exit(1);
}

let bins = [];
let authToken = null;

function seuilAtteint(pct) {
    if (pct >= 100) return 100;
    if (pct >= 75) return 75;
    if (pct >= 50) return 50;
    if (pct >= 25) return 25;
    return 0;
}

function distanceFromPct(pct) {
    return Math.round(100 - (pct / 100) * 50);
}

async function login() {
    const res = await fetch(API + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Login echoue');
    authToken = data.token;
    return data.token;
}

async function fetchBins() {
    try {
        const res = await fetch(API + '/api/bins', {
            headers: { 'Authorization': 'Bearer ' + authToken },
        });
        const data = await res.json();

        if (!Array.isArray(data)) {
            console.error('Erreur /api/bins :', JSON.stringify(data));
            return;
        }

        data.forEach(function(b) {
            const existing = bins.find(function(x) { return x.id === b.bin_id; });
            if (!existing) {
                bins.push({
                    id: b.bin_id,
                    name: b.name,
                    token: b.device_token,
                    pct: b.percentage !== null ? b.percentage : 0,
                    speed: 1 + Math.random() * 3,
                    dernierSeuil: b.percentage !== null ? b.percentage : -1,
                });
                console.log('[+] Poubelle : #' + b.bin_id + ' - ' + b.name + ' (' + b.device_token + ')');
            }
        });

        const ids = data.map(function(b) { return b.bin_id; });
        bins = bins.filter(function(x) { return ids.indexOf(x.id) !== -1; });
    } catch (e) {
        console.error('Erreur fetch bins :', e.message);
    }
}

async function envoyerHTTP(bin, pct) {
    const body = {
        device_token: bin.token,
        percentage: pct,
        distance: distanceFromPct(pct),
        api_key: API_KEY,
        status: pct >= 100 ? 'FULL' : 'OK',
    };
    try {
        const res = await fetch(API + '/api/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        console.log('[>] #' + bin.id + ' ' + bin.name + ' -> ' + pct + '% ' + (res.ok ? 'OK' : 'FAIL'));
    } catch (e) {
        console.error('Erreur envoi #' + bin.id + ' :', e.message);
    }
}

async function main() {
    console.log('Simulateur demarre');
    await login();
    console.log('Connecte en admin');
    await fetchBins();

    setInterval(async function() {
        await fetchBins();
        for (let i = 0; i < bins.length; i++) {
            const bin = bins[i];
            bin.pct = Math.min(100, bin.pct + bin.speed * (0.5 + Math.random()));
            if (bin.pct >= 100 && Math.random() < 0.15) {
                bin.pct = 0;
                console.log('[X] #' + bin.id + ' ' + bin.name + ' vide');
                await envoyerHTTP(bin, 0);
                bin.dernierSeuil = 0;
                continue;
            }
            const s = seuilAtteint(Math.floor(bin.pct));
            if (s > bin.dernierSeuil) {
                await envoyerHTTP(bin, s);
                bin.dernierSeuil = s;
            }
        }
    }, 4000);
}

main().catch(function(e) {
    console.error('Erreur fatale :', e.message);
    process.exit(1);
});