const express = require('express');
const multer = require('multer');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
global.sessionMetadataStore = {};

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const TMP_DIR = path.resolve('/tmp/zsign_sessions');
if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    let sessionMetadataStore = {}; 
}

// Locate this block in server.js and replace it with this dynamic version:
app.use(express.static(__dirname));

// FIXED: Handles standard root (/) AND nested cloud-proxy paths seamlessly
app.get(['/', '/*'], (req, res, next) => {
    // If the browser is asking for an asset file (like .js, .css, .png), pass it along
    if (path.extname(req.path)) {
        return next();
    }
    // Otherwise, always force load your clean dashboard interface
    res.sendFile(path.join(__dirname, 'index.html'));
});


const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!req.sessionDir) {
            const sessionId = crypto.randomUUID();
            req.sessionId = sessionId;
            req.sessionDir = path.join(TMP_DIR, sessionId);
            fs.mkdirSync(req.sessionDir, { recursive: true });
            fs.mkdirSync(path.join(req.sessionDir, 'tweaks'), { recursive: true });
        }
        if (file.fieldname === 'tweaks') {
            cb(null, path.join(req.sessionDir, 'tweaks'));
        } else {
            cb(null, req.sessionDir);
        }
    },
    filename: (req, file, cb) => {
        if (file.fieldname === 'ipa') cb(null, 'input.ipa');
        else if (file.fieldname === 'prov') cb(null, 'embedded.mobileprovision');
        else if (file.fieldname === 'p12') cb(null, 'cert.p12');
        else cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

const initSession = (req, res, next) => {
    const sessionId = crypto.randomUUID();
    req.sessionId = sessionId;
    req.sessionDir = path.join(TMP_DIR, sessionId);
    fs.mkdirSync(req.sessionDir, { recursive: true });
    fs.mkdirSync(path.join(req.sessionDir, 'tweaks'), { recursive: true });
    next();
};

app.post('/sign', initSession, upload.fields([
    { name: 'ipa', maxCount: 1 },
    { name: 'prov', maxCount: 1 },
    { name: 'p12', maxCount: 1 },
    { name: 'tweaks', maxCount: 20 }
]), (req, res) => {
    // Treat password carefully; clean out trailing whitespace leaks
    const password = (req.body.password || '').trim();
    const appName = req.body.appName || '';
    const bundleId = req.body.bundleId || '';
    
    const sessionDir = req.sessionDir;
    const sessionId = req.sessionId;

    const inputIpa = path.join(sessionDir, 'input.ipa');
    const outputIpa = path.join(sessionDir, 'signed.ipa');
    const prov = path.join(sessionDir, 'embedded.mobileprovision');
    const p12 = path.join(sessionDir, 'cert.p12');
    const tweaksFolder = path.join(sessionDir, 'tweaks');

        global.sessionMetadataStore[sessionId] = {
        customAppName: appName.trim(),
        customBundleId: bundleId.trim()
    };

    let zsignFlags = [];
    zsignFlags.push(`-k "${p12}"`);
    
    // Explicitly fallback to explicit blank quotes if password parameter is missing
    zsignFlags.push(`-p "${password}"`);
    
    zsignFlags.push(`-m "${prov}"`);
    zsignFlags.push(`-o "${outputIpa}"`);

    if (appName.trim() !== '') {
        zsignFlags.push(`-n "${appName.trim()}"`);
    }

    if (bundleId.trim() !== '') {
        zsignFlags.push(`-b "${bundleId.trim()}"`);
    }

    if (fs.existsSync(tweaksFolder)) {
        const injectedMods = fs.readdirSync(tweaksFolder);
        injectedMods.forEach(file => {
            const filePath = path.join(tweaksFolder, file);
            
            if (file.endsWith('.dylib')) {
                zsignFlags.push(`-l "${filePath}"`);
            } else if (file.endsWith('.deb')) {
                const extractPath = path.join(tweaksFolder, `ext_${file}`);
                fs.mkdirSync(extractPath, { recursive: true });
                
                try {
                    execSync(`ar -x "${filePath}" --output="${extractPath}"`);
                    let dataTar = fs.readdirSync(extractPath).find(f => f.startsWith('data.tar'));
                    if (dataTar) {
                        execSync(`tar -xf "${path.join(extractPath, dataTar)}" -C "${extractPath}"`);
                        const findDylibs = (dir) => {
                            fs.readdirSync(dir).forEach(f => {
                                const fp = path.join(dir, f);
                                if (fs.statSync(fp).isDirectory()) {
                                    findDylibs(fp);
                                } else if (f.endsWith('.dylib')) {
                                    zsignFlags.push(`-l "${fp}"`);
                                }
                            });
                        };
                        findDylibs(extractPath);
                    }
                } catch(e) { 
                    console.error("Deb unpack failure context skipped:", e); 
                }
            }
        });
    }

    let zsignCmd = `zsign ${zsignFlags.join(' ')} "${inputIpa}"`;
    console.log("Executing absolute command path:", zsignCmd);

    // REPLACE your old exec callback section with this clean input cacher:
    exec(zsignCmd, (error, stdout, stderr) => {
        if (error) {
            if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            let shortError = (stderr || stdout || error.message).replace(/\n/g, '<br>');
            return res.status(500).json({ error: 'Signing operation rejected.', details: shortError });
        }

        if (!fs.existsSync(outputIpa)) {
            if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            return res.status(500).json({ error: 'Signing failure.', details: 'The compiled zsign binary failed to write an output file.' });
        }

        // =========================================================================
        // LINKED ENGINE LOGIC: Connect form fields straight to the global cache store
        // =========================================================================
        let finalBundleId = bundleId.trim();
        let finalAppTitle = appName.trim();

        // Safe backstops: If the user left fields empty, fallback to clean baselines
        if (finalBundleId === "") finalBundleId = "com.isignbot.signedapp";
        if (finalAppTitle === "") finalAppTitle = "iSignBot Signed Package";

        // Save these identical strings right into your persistent global tracking database
        global.sessionMetadataStore[sessionId] = {
            customAppName: finalAppTitle,
            customBundleId: finalBundleId,
            customVersion: "1.0.0" // Clean uniform version baseline
        };
        // =========================================================================

        res.json({
            status: 'success',
            sessionId: sessionId,
            download_url: `${SERVER_URL}/download/${sessionId}/signed.ipa`,
            install_url: `itms-services://?action=download-manifest&url=${SERVER_URL}/plist/${sessionId}/manifest.plist`
        });
    });


    });
});

app.get('/download/:sessionId', (req, res) => {
    const sessionDir = path.join(TMP_DIR, req.params.sessionId);
    const ipaPath = path.join(sessionDir, 'signed.ipa');

    if (!fs.existsSync(ipaPath)) {
        return res.status(404).send('Resource expired or invalid.');
    }

    res.download(ipaPath, 'signed.ipa', (err) => {
        if (!err) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`Wiped temporary storage workspace context for session: ${req.params.sessionId}`);
        }
    });
});

// 1. FIXED DOWNLOAD ENDPOINT (Removes the aggressive, breaking immediate deletion)
app.get('/download/:sessionId', (req, res) => {
    const sessionDir = path.join(TMP_DIR, req.params.sessionId);
    const ipaPath = path.join(sessionDir, 'signed.ipa');

    if (!fs.existsSync(ipaPath)) {
        return res.status(404).send('Resource expired, invalid, or already cleared.');
    }

    // Streams the signed package straight to the device safely
    res.download(ipaPath, 'signed.ipa');
});

// =========================================================================
// FIXED: CLEAN MANIFEST PLISt ROUTE GENERATOR (No syntax blocks, no dummy text)
// =========================================================================
app.get('/plist/:sessionId/manifest.plist', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionDir = path.join(TMP_DIR, sessionId);
    const ipaPath = path.join(sessionDir, 'signed.ipa');

    if (!fs.existsSync(ipaPath)) {
        return res.status(404).send('Session mapping profiles expired or missing.');
    }

    // Pull verified text parameters instantly out of your global memory cache maps
    const cachedMeta = global.sessionMetadataStore[sessionId];

    // If the lookup fails or fields are blank, terminate early so you see it in the Render logs
    if (!cachedMeta || !cachedMeta.customBundleId || !cachedMeta.customAppName) {
        return res.status(400).send('Metadata extraction pipeline unresolved or missing values.');
    }

    const finalBundleId = cachedMeta.customBundleId;
    const finalAppTitle = cachedMeta.customAppName;
    const finalAppVersion = cachedMeta.customVersion;

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://apple.com">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${SERVER_URL}/install-ipa/${sessionId}/signed.ipa</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${finalBundleId}</string>
                <key>bundle-version</key>
                <string>${finalAppVersion}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${finalAppTitle}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;

    res.header('Content-Type', 'application/xml');
    res.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.status(200).send(plistContent);
});

// =========================================================================
// FIXED: COMPATIBLE OTA BINARY CONNECTOR PIPELINE
// =========================================================================
app.get('/install-ipa/:sessionId/signed.ipa', (req, res) => {
    const ipaPath = path.join(TMP_DIR, req.params.sessionId, 'signed.ipa');
    if (!fs.existsSync(ipaPath)) {
        return res.status(404).send('File missing or layout session expired.');
    }
    res.attachment('signed.ipa');
    res.sendFile(ipaPath);
});


// Replace just the setInterval section at the bottom of server.js with this:
// Locate this block at the very bottom of your server.js and change the timings:
setInterval(() => {
    if (!fs.existsSync(TMP_DIR)) return;
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // Keep files alive for exactly 5 minutes

    fs.readdirSync(TMP_DIR).forEach(sessionId => {
        const folderPath = path.join(TMP_DIR, sessionId);
        try {
            const stats = fs.statSync(folderPath);
            const relative = path.relative(TMP_DIR, folderPath);
            const isSafePath = relative && !relative.startsWith('..') && !path.isAbsolute(relative);

            if (isSafePath && (now - stats.mtime.getTime() > maxAge)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
                console.log(`Automated GC Wiped: ${sessionId}`);
            }
        } catch (e) {}
    });
}, 60000);




app.listen(PORT, () => {
    console.log(`iSignBot engine actively tracking sockets on port ${PORT}`);
});
