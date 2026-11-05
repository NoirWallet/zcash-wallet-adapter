from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Preformatted, KeepTogether, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from xml.sax.saxutils import escape
from pathlib import Path
import re
src=Path('downloads/WalletConnect-Guide.md').read_text()
styles=getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodyGuide',fontName='Helvetica',fontSize=10,leading=14,spaceAfter=8,textColor=colors.HexColor('#263347')))
styles.add(ParagraphStyle(name='CodeGuide',fontName='Courier',fontSize=8,leading=10,backColor=colors.HexColor('#F1F4F8'),borderPadding=10,spaceBefore=5,spaceAfter=12))
styles['Title'].textColor=colors.HexColor('#152C50')
styles['Heading2'].textColor=colors.HexColor('#152C50')
styles['Heading2'].fontSize=13
story=[]
chunks=re.split(r'```[^\n]*\n(.*?)```',src,flags=re.S)
for i,chunk in enumerate(chunks):
 if i%2:
  story.append(Preformatted(chunk.rstrip(),styles['CodeGuide']))
  continue
 for para in re.split(r'\n\s*\n',chunk.strip()):
  if not para: continue
  if para.startswith('|'):
   rows=para.splitlines()
   for row in rows[2:]:
    cells=[c.strip() for c in row.strip('|').split('|')]
    if len(cells)==2: story.append(Paragraph('<b>'+escape(cells[0])+':</b> '+escape(cells[1]).replace('`',''),styles['BodyGuide']))
   continue
  if para.startswith('## 3.') or para.startswith('## 4.'): story.append(PageBreak())
  if para.startswith('# '): style=styles['Title']; para=para[2:]
  elif para.startswith('## '): style=styles['Heading2']; para=para[3:]
  else: style=styles['BodyGuide']
  para=escape(para).replace('`','')
  para=para.replace('\n- ','<br/>• ').replace('\n',' ')
  if para.startswith('- '): para='• '+para[2:]
  story.append(Paragraph(para,style))
def footer(c,d):
 c.setStrokeColor(colors.HexColor('#D9E1EB'));c.line(42,37,553,37)
 c.setFont('Helvetica',8);c.setFillColor(colors.HexColor('#66758A'))
 c.drawString(42,25,'NOIR  /  WalletConnect Integration');c.drawRightString(553,25,str(d.page))
doc=SimpleDocTemplate('output/pdf/Noir-WalletConnect-Guide.pdf',pagesize=(595,842),rightMargin=42,leftMargin=42,topMargin=36,bottomMargin=49,title='Noir WalletConnect Guide',author='Noir')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
