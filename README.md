Распознавание больших файлов через Yandex SpeechKit.

[Распознавание длинных аудио](https://cloud.yandex.ru/docs/speechkit/stt/transcribation) - документация

### Что делает
1. Конвертирует файл в OGG Opus
2. Заливает файл на Yandex Object Storage
3. Отправляет файл на распознавание
4. Дожидается результата (проверка раз в 10 секунд)

Данные сохраняет в `~/yandex-stt/`.

### Установка
```
npm install -g yandex-speechkit-talk-recognition
```

### Как запустить
1. Создать сервисный аккаунт, получить API ключ (в документации), вписать его в `config.js`.
2. Создать статический ключ, получить Id и Secret
3. Запустить `yandex-stt --file <путь_к_файлу_с_голосом>`, создастся конфиг в `~/yandex-stt/config.js`.
4. Заполнить конфиг
5. Запускать `yandex-stt --file <path>` или yandex-stt --id abcde`

### Стоимость
Распознавание с низким приоритетом (deferred) стоит примерно 15 копеек/минута, грубо говоря, 10 руб/час. [Тарифы](https://cloud.yandex.ru/docs/speechkit/pricing#rules-stt-long).
