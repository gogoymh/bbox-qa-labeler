# CAD QA Label

이미지를 업로드하고, 이미지 위에 bbox를 드래그해서 그린 뒤 question/answer를 함께 JSON으로 다운로드하는 React 앱입니다.

## 요구 사항

- Node.js 20 이상 권장
- npm

## 설치

```bash
npm install
```

## 개발 서버 실행

```bash
npm run dev
```

기본 Vite 서버가 실행되며, 터미널에 표시되는 로컬 URL로 접속하면 됩니다.

## 빌드 및 실행

아래 스크립트를 실행하면 의존성이 없을 때 `npm install`을 먼저 수행하고, 이후 프로덕션 빌드를 생성한 뒤 라벨링 앱을 `5174` 포트로 실행합니다.

```bash
./build.sh
```

브라우저에서 아래 주소로 접속해 라벨링하면 됩니다.

```text
http://127.0.0.1:5174/
```

빌드만 직접 실행하려면 npm 명령을 사용하면 됩니다.

```bash
npm run build
```

빌드 결과는 `dist/` 디렉터리에 생성됩니다.

## 다운로드 JSON 형식

JSON에는 이미지 base64 `dataUrl`을 넣지 않습니다. 대신 원본 이미지 이름과 크기 같은 메타데이터만 저장합니다.

```json
{
  "version": 1,
  "type": "cad-qa-label",
  "recordCount": 1,
  "records": [
    {
      "image": {
        "name": "sample.png",
        "width": 1200,
        "height": 800
      },
      "bboxs": [],
      "question": "질문",
      "answer": "답변"
    }
  ]
}
```

다운로드 파일명은 원본 이미지 이름을 활용해 `sample.labels.json` 형태로 생성됩니다. 여러 이미지가 섞여 있으면 첫 이미지 이름 뒤에 추가 이미지 수가 붙습니다.
