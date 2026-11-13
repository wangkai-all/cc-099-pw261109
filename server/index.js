/**
 * 本地模拟 WFS 服务入口（Node 内置 http，零第三方依赖）。
 * 路由：
 *   GET /wfs/:mode?request=GetCapabilities
 *   GET /wfs/:mode?request=GetFeature&...
 * 也兼容不带 mode 的 /wfs（按 standard 处理）。
 */
import { createServer } from 'node:http';
import { capabilitiesXml, handleGetFeature, MODES } from './wfs.js';

const PORT = parseInt(process.env.WFS_PORT ?? '8787', 10);

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  const seg = url.pathname.split('/').filter(Boolean); // ['wfs', mode?]

  if (seg[0] !== 'wfs') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found: 示例服务仅暴露 /wfs/:mode 路径');
    return;
  }

  const mode = seg[1] && MODES[seg[1]] ? seg[1] : 'standard';
  const request = url.searchParams.get('request') ?? '';

  try {
    if (request === 'GetCapabilities' || url.searchParams.size === 0) {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(capabilitiesXml(mode));
      return;
    }
    if (request === 'GetFeature') {
      const out = handleGetFeature(url.searchParams, mode);
      res.writeHead(out.status, { 'Content-Type': out.contentType });
      res.end(out.body);
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(
      `<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>不支持的请求：${request}</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`,
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`模拟服务内部错误：${err.stack}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-wfs]  listening on http://127.0.0.1:${PORT}/wfs/{${Object.keys(MODES).join('|')}}`);
});
