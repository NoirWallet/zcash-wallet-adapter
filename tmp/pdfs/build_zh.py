from pathlib import Path
import re
src=Path('downloads/WalletConnect-Guide.md').read_text()
blocks=re.findall(r'```[^\n]*\n.*?```',src,re.S)
text='''# Noir WalletConnect：React 接入指南

通过 WalletProvider 注册 WalletConnect 适配器，在 React 组件中使用 useWallet() 连接钱包、读取地址并发送 ZEC。

## 1. 准备与安装

准备 Reown/WalletConnect 项目 ID，并安装、解锁支持 WalletConnect 和 NOIR_WC_PAIR 消息的 Noir 扩展。请确认实际安装版本支持这些功能。

{b0}

## 2. 配置 Provider

以下示例使用无界面的 React Provider 和自定义按钮。代码需在客户端执行；Next.js 项目请添加 'use client'。将 adapters 数组放在组件外，保持引用稳定。

{b1}

将 projectId、应用名称、URL 和图标替换为实际值。用户点击连接后，适配器将配对 URI 传给扩展，用户需在 Noir 内批准连接。autoConnect 会尝试恢复已有的兼容会话。

## 3. 在组件中使用 Hook

以下组件演示连接、显示地址、发送 ZEC 和断开连接。发送前必须替换收款地址占位符。busy 状态用于防止重复点击，status 显示操作结果或错误。代码对应上一节导入的 WalletPanel.tsx。

{b2}

## 4. 使用说明

- 用户需在钱包中批准连接与转账。amount 是以 ZEC 为单位的十进制字符串；fundingSource 可选 shielded（隐私余额）或 transparent（透明余额）。
- 如需内置钱包选择和配对二维码，从包根入口导入 WalletProvider，并导入 @rhea-finance/zcash-wallet-adapter/styles.css。useWallet 仍从 /react 入口导入。内置选择器负责连接，可省略示例中的自定义连接按钮。
- 自定义二维码界面可显示 onDisplayUri 返回的 URI。接收方钱包必须支持相同的 Zcash 协议，并提供扫码或打开 URI 的入口。
- 网络：Zcash 主网。Namespace：bip122。Chain ID：bip122:00040fe8ec8471911baa1db1266ea15d。
- 支持的方法：zcash_getAddress、zcash_getBalance、zcash_transfer、zcash_signMessage。消息签名需钱包和会话支持；当前不提供 PCZT 签名。

仅支持 Ethereum 的 WalletConnect 配置无法处理此 Zcash 会话。如扩展没有响应，请检查安装版本是否支持 WalletConnect 和 NOIR_WC_PAIR、钱包是否解锁，以及项目 ID 是否有效。
'''
for i,b in enumerate(blocks):text=text.replace('{b'+str(i)+'}',b)
Path('tmp/pdfs/guide-zh.md').write_text(text)
s=Path('tmp/pdfs/build_guide.py').read_text()
s=s.replace("src=Path('downloads/WalletConnect-Guide.md').read_text()", "src=Path('tmp/pdfs/guide-zh.md').read_text()")
s=s.replace('styles=getSampleStyleSheet()', '''from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont('Chinese', '/System/Library/Fonts/STHeiti Light.ttc', subfontIndex=0))
styles=getSampleStyleSheet()''')
s=s.replace("fontName='Helvetica',fontSize=10", "fontName='Chinese',wordWrap='CJK',fontSize=10")
s=s.replace("styles['Title'].textColor", "styles['Title'].fontName='Chinese'\nstyles['Heading2'].fontName='Chinese'\nstyles['Title'].textColor")
s=s.replace('output/pdf/Noir-WalletConnect-Guide.pdf','output/pdf/Noir-WalletConnect-Guide-ZH.pdf')
exec(s)
