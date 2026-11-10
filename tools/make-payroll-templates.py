"""급여정산 엑셀 양식 만들기 — 기존 제출본(7월)에서 개인정보·월별 값만 지워 templates/ 에 저장한다 (서버가 관리자 로그인에만 내려줌).
사용: python3 tools/make-payroll-templates.py <제출본 폴더>
  폴더에 7월_근무시간기록표_단시간사업소득_명동타운레디영.xlsx, 7월_급여변경사항_명동타운레디영_2607.xlsx 필요 (openpyxl)"""
import openpyxl, sys, re, os
src=sys.argv[1].rstrip('/')+'/'
out=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','templates')+'/'
# 근무시간기록표: 유소 시트를 빈 양식(TEMPLATE)으로
wb=openpyxl.load_workbook(src+'7월_근무시간기록표_단시간사업소득_명동타운레디영.xlsx')
del wb['육호청']
ws=wb['유소']; ws.title='TEMPLATE'
ws['C4']=None; ws['C6']=None; ws['H5']=None; ws['H6']=None
for r in range(9,40):
    ws.cell(r,3).value='휴무'
    for c in (4,5,6): ws.cell(r,c).value=None
wb.save(out+'worktime-template.xlsx')
# 급여변경사항: 값만 비우기 (예시 행·머리글·서식 유지)
wb=openpyxl.load_workbook(src+'7월_급여변경사항_명동타운레디영_2607.xlsx')
def clear(ws, r1, r2, c1, c2):
    for r in range(r1,r2+1):
        for c in range(c1,c2+1): ws.cell(r,c).value=None
clear(wb['입사'],3,25,2,13); wb['입사']['D10']=None
clear(wb['퇴사'],4,23,2,6)
clear(wb['수당'],4,16,2,18)
clear(wb['수당_미신고인원'],4,5,2,19)
clear(wb['급여현황표_미신고인원'],5,14,2,6)
clear(wb['급여현황표_상용'],5,14,2,6)
clear(wb['급여현황표_일용직'],5,15,2,40)
clear(wb['이메일'],4,28,2,4)
# 예시 행 주민번호 → 가짜 값
for n,cell in [('퇴사','C3'),('수당','C3'),('수당_미신고인원','C3'),('급여현황표_미신고인원','C4'),('급여현황표_상용','C4'),('급여현황표_일용직','C4')]:
    if wb[n][cell].value is not None and re.search(r'\d{6}',str(wb[n][cell].value)): wb[n][cell].value='000000-0000000'
wb.save(out+'payroll-changes-template.xlsx')
# ExcelJS는 Excel 기본 경로(xl/commentsN.xml, xl/drawings/vmlDrawingN.vml, 상대 경로 rels)만 읽으므로 맞춰 준다
import zipfile, shutil, re
def ren(n):
    n=re.sub(r'^xl/comments/comment(\d+)\.xml$', r'xl/comments\1.xml', n)
    return re.sub(r'^xl/drawings/commentsDrawing(\d+)\.vml$', r'xl/drawings/vmlDrawing\1.vml', n)
for f in ['worktime-template.xlsx','payroll-changes-template.xlsx']:
    p=out+f; tmp=p+'.tmp'
    with zipfile.ZipFile(p) as zi, zipfile.ZipFile(tmp,'w',zipfile.ZIP_DEFLATED) as zo:
        for it in zi.infolist():
            data=zi.read(it.filename)
            if it.filename.startswith('xl/worksheets/_rels/'):
                data=re.sub(rb'Target="/xl/comments/comment(\d+)\.xml"', rb'Target="../comments\1.xml"', data)
                data=re.sub(rb'Target="/xl/drawings/commentsDrawing(\d+)\.vml"', rb'Target="../drawings/vmlDrawing\1.vml"', data)
            if it.filename=='[Content_Types].xml':
                data=re.sub(rb'/xl/comments/comment(\d+)\.xml', rb'/xl/comments\1.xml', data)
                data=re.sub(rb'/xl/drawings/commentsDrawing(\d+)\.vml', rb'/xl/drawings/vmlDrawing\1.vml', data)
            zo.writestr(ren(it.filename), data)
    shutil.move(tmp,p)
