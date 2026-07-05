const express = require('express');
const multer = require('multer');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const TMP_DIR = path.resolve('/tmp/zsign_sessions');
if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
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

    exec(zsignCmd, (error, stdout, stderr) => {
        console.log("--- zsign engine stdout ---", stdout);
        console.error("--- zsign engine stderr ---", stderr);

        if (error) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            
            // Clean up the formatting for readability on your mobile viewport
            let shortError = (stderr || stdout || error.message).replace(/\n/g, '<br>');
            return res.status(500).json({ 
                error: 'Signing operation rejected by backend binary.', 
                details: shortError 
            });
        }

        if (!fs.existsSync(outputIpa)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
            return res.status(500).json({ error: 'Signing failure.', details: 'The compiled zsign binary failed to write an output file.' });
        }

// REPLACE IT WITH THIS CORRECTED BLOCK:
res.json({
    status: 'success',
    sessionId: sessionId,
    download_url: `${SERVER_URL}/download/${sessionId}/signed.ipa`,
    install_url: `itms-services://?action=download-manifest&url=${SERVER_URL}/plist/${sessionId}/manifest.plist`
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

// 2. FIXED PLIST MANIFEST ROUTE
// REPLACE your old manifest.plist endpoint entirely with this architecture fix:
app.get('/plist/:sessionId/manifest.plist', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionDir = path.join(TMP_DIR, sessionId);
    const ipaPath = path.join(sessionDir, 'signed.ipa');

    if (!fs.existsSync(ipaPath)) {
        return res.status(404).send('Session mapping profiles expired or missing.');
    }

    // =========================================================================
    // DYNAMIC METADATA EXTRACTION PIPELINE
    // =========================================================================
    let bundleId = `com.isignbot.dynamicapp.${sessionId}`; // Safe backup fallback
    let appTitle = "iSignBot Signed Package";

    try {
        // 1. Crack open the signed app's internal config framework directory using fast system scripts
        const inspectDir = path.join(sessionDir, 'inspect_plist');
        execSync(`unzip -q "${ipaPath}" -d "${inspectDir}"`);
        
        const payloadPath = path.join(inspectDir, 'Payload');
        const appFolder = fs.readdirSync(payloadPath).find(f => f.endsWith('.app'));
        const plistPath = path.join(payloadPath, appFolder, 'Info.plist');
        
        // 2. Extract the EXACT compiled Bundle Identifier iOS requires for verification
        const extractedId = execSync(`plutil -extract CFBundleIdentifier string "${plistPath}"`, { encoding: 'utf8' }).trim();
        // 3. Extract the EXACT Display Name to keep system notifications completely uniform
        let extractedName = "";
        try {
            extractedName = execSync(`plutil -extract CFBundleDisplayName string "${plistPath}"`, { encoding: 'utf8' }).trim();
        } catch(e) {
            extractedName = execSync(`plutil -extract CFBundleName string "${plistPath}"`, { encoding: 'utf8' }).trim();
        }

        if (extractedId) bundleId = extractedId;
        if (extractedName) appTitle = extractedName;

        // 4. Wipe our temporary validation files from disk immediately to save memory
        fs.rmSync(inspectDir, { recursive: true, force: true });
    } catch (extractErr) {
        console.log("Fallback Notice: System defaulted to session tracking IDs:", extractErr.message);
    }
    // =========================================================================

    // IMMUTABLE PROFILES STRING: Fully matched to your unique app bundle configurations
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
                    <string>${SERVER_URL}/install-ipa/${sessionId}</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${bundleId}</string>
                <key>bundle-version</key>
                <string>1.0.0</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${appTitle}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;

    // STRICT APPLE DEVICE MIME ALIGNMENT HEADERS
    res.header('Content-Type', 'application/xml');
    res.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.status(200).send(plistContent);
});


// FIXED: Appended /signed.ipa to the route pattern so it matches the new link
app.get('/download/:sessionId/signed.ipa', (req, res) => {
    const sessionDir = path.join(TMP_DIR, req.params.sessionId);
    const ipaPath = path.join(sessionDir, 'signed.ipa');

    if (!fs.existsSync(ipaPath)) {
        return res.status(404).send('The requested signed app has expired or was already cleared.');
    }

    // Streams the file straight to your phone with its proper filename layout
    res.download(ipaPath, 'signed.ipa');
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
