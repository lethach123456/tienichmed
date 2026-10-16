# MedReview AI content

Chrome Extension (Manifest V3), phiên bản 1.6.8, để quản lý hàng đợi bài viết, hồ sơ bác sĩ, Toplist, dịch Việt → Anh, tạo ảnh AI và kiểm tra/sửa ảnh thật của cơ sở; tiện ích nhập prompt vào ChatGPT/Grok/Claude/Gemini đang mở, đọc JSON phản hồi và lưu lại trong tiện ích.

Panel làm việc xuất hiện ở mép phải trên `chatgpt.com`, `grok.com`, `claude.ai` và `gemini.google.com`. Panel tự nhận diện AI theo URL và có một nút **Chạy/Dừng**: bấm trong tab nào thì chỉ tab đó nhận bài. Có thể chạy nhiều tab của cùng một AI hoặc các AI khác nhau song song; mỗi bài được khóa theo tab nên không bị nhận trùng.

Mỗi tab có bộ nhớ riêng: nguồn tác vụ/loại dịch, danh sách chờ, prompt, kết quả JSON, trạng thái gửi, cấu hình API và nhãn tài khoản. Ví dụ chọn **Cơ sở y tế** rồi **Chạy** ở Gemini, và chọn **Dịch Việt → Anh** rồi **Chạy** ở ChatGPT; hai luồng hoạt động độc lập. Đổi nguồn, xoá danh sách hoặc bấm **Dừng** chỉ tác động tab đang thao tác. Tải lại trang vẫn khôi phục bộ nhớ của chính tab đó; mở tab mới tạo vùng dữ liệu riêng. Bộ điều phối/khóa chống trùng bài vẫn dùng chung nội bộ để không gửi cùng một bài sang hai AI. Lịch sử giữ hai bài gửi thành công gần nhất **cho từng tab và nguồn**, bài lỗi giữ lại để gửi lại.

Hàng đợi tự kiểm tra khôi phục mỗi phút và khi tiến trình nền khởi động lại. Nếu tab đang chạy bị mất lượt chuyển bài hoặc còn giữ ID của bài đã xong, tiện ích tiếp tục bài chờ của đúng tab, không chạy lại bài đang viết/gửi và không khởi động tab đã bấm Dừng. Thời gian nghỉ 60 giây được lưu bền vững; panel hiển thị số bài chờ hoặc lý do bị khóa thay vì báo đợi chung chung. API **lấy danh sách** có giới hạn 60 giây để không giữ hàng đợi mãi khi mất mạng; API **gửi kết quả** vẫn không có thời gian cắt tự động.

## Cài đặt

### Cập nhật khi gặp `Resource::kQuotaBytes quota exceeded`

Đây là lỗi vượt hạn mức lưu trữ của Chrome, không phải lỗi API bác sĩ. Bản 1.6.6 thêm quyền `unlimitedStorage` cho dữ liệu cục bộ chứa prompt, JSON và biên nhận gửi lại; không đổi API hoặc khóa bài, không xóa/cắt JSON để né lỗi. Lịch sử vẫn giữ hai bài thành công cho từng tab/nguồn; bài lỗi, chưa gửi và chưa xác nhận vẫn được giữ nguyên.

Sau khi cập nhật mã trong **đúng thư mục đang Load unpacked**, vào `chrome://extensions`, bấm **Tải lại / Reload** tiện ích (cho phép quyền mới nếu Chrome yêu cầu). Tải lại tab AI rồi bấm **Thử lại**. Không gỡ rồi cài lại tiện ích hoặc xóa dữ liệu lưu trữ, vì làm vậy có thể mất JSON đang chờ. Chỉ reload tab AI mà chưa reload tiện ích thì quyền mới chưa được áp dụng.

Thông báo đầy bộ nhớ được phân biệt với HTTP 401/403/503 và không hướng dẫn sửa DB/schema khi lỗi xuất phát từ lưu trữ. Nếu ghi dữ liệu thất bại, tiện ích không xóa nội dung cũ trước khi lưu được hàng đợi mới và không gửi kết quả lên website khi chưa lưu được bản gửi lại.

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Chọn **Load unpacked** và chọn thư mục tiện ích này.
3. Mở `https://chatgpt.com`, `https://grok.com`, `https://claude.ai` và/hoặc `https://gemini.google.com`, đăng nhập và vào một cuộc trò chuyện ở mỗi tab. Chỉ cần mở những AI muốn sử dụng.
4. Mở panel trên tab AI, bấm **Tải lại** để lấy một bài từ API, sau đó bấm **Chạy**. Nút đó đổi thành **Dừng** trong lúc chạy trên đúng tab đó.

Trong **Cài đặt** (⚙), có URL riêng cho **Cơ sở y tế**, **Viết hồ sơ bác sĩ**, **Fix ảnh cơ sở y tế**, **Toplist**, **Tạo ảnh AI** và **Dịch Việt → Anh**. Các URL mặc định:

- Cơ sở y tế: `https://medreview.vn/api/medical/facilities-needing-content.php?page=1&limit=1&type=facility`
- Cập nhật bài cơ sở: `https://medreview.vn/api/medical/facility-content-update.php`
- Bác sĩ cần nghiên cứu: `https://medreview.vn/api/medical/doctors-needing-content.php?page=1&limit=25`
- Nhận JSON hồ sơ bác sĩ: `https://medreview.vn/api/medical/doctor-content-update.php`
- Kiểm tra biên nhận bác sĩ: `https://medreview.vn/api/medical/doctor-content.php`
- Lấy cơ sở kiểm tra ảnh thật: `https://medreview.vn/api/medical/facilities-needing-image-fix.php?limit=10`
- Nhận kết quả Fix ảnh: `https://medreview.vn/api/medical/facility-image-fix-update.php`
- Khóa bài giữa các máy/tab: `https://medreview.vn/api/medical/writer-claim.php`
- Lấy Toplist (cơ sở, bác sĩ, hỗn hợp): `https://medreview.vn/api/medical/toplists-needing-members.php?page=1&limit=1`
- Cập nhật Toplist: `https://medreview.vn/api/medical/toplist-members-update.php`
- Lấy danh sách tạo ảnh AI: `https://medreview.vn/api/medical/facilities-needing-ai-images.php?page=1&limit=1&min_images=3`
- Nhận ảnh AI: `https://medreview.vn/api/medical/facility-ai-image-update.php`
- Lấy prompt/lưu bản dịch: `https://medreview.vn/api/medical/translate-content.php`

Các API dùng header `X-Medical-Api-Key` lấy từ file cấu hình riêng `api-key.local.js` của bản cài (file này bị Git bỏ qua; không đưa khóa vào prompt hoặc mã phát hành). Worker dùng chế độ classic để nạp cấu hình này bằng `importScripts`. Chọn **Toplist** tại **Nguồn lấy bài** để tải danh sách. Các nguồn thông thường lấy một bài mỗi lần; nguồn bác sĩ lấy lô tối đa 25 bản ghi theo cấu hình để bỏ qua bác sĩ đang được phiên khác giữ khóa, nhưng mỗi tab vẫn chỉ viết một bác sĩ tại một thời điểm. Sau khi bài được lưu thành công, tab nghỉ 60 giây rồi xử lý bài tiếp theo. Bài lỗi không làm extension tải tiếp lô mới. Extension dùng nguyên `prompt` từ API. Các bài đã tải từ trước vẫn nằm trong hàng đợi, và mỗi bài giữ loại riêng để tự gửi về đúng API kể cả khi bấm **Gửi lại** hoặc đổi nguồn tải bài. URL đã lưu trước đây trên `top.top` hoặc `xxhihi.site` sẽ tự chuyển sang `medreview.vn` khi extension khởi động.

## Cẩm nang: JSON gọn và file ảnh riêng

AI trả một block `json` đầy đủ bài với `img src="link1"`, `link2`… và `image_files` gồm `key`, `filename`, `mime`, `bytes`, `sha256`. Ngay dưới block đính kèm các file thật `link1_base64.txt`, `link2_base64.txt`…; mỗi TXT chỉ chứa một data URI PNG/JPEG/WebP mã hoá từ bytes ảnh gốc bằng chương trình. Không in chuỗi BASE64 dài vào chat. Hash và số bytes tính trên ảnh gốc, không phải văn bản TXT.

Tiện ích đợi công cụ tạo ảnh và file hoàn tất, chỉ đọc file trong chính câu trả lời chứa JSON, kiểm tra bytes/SHA-256 và giải mã raster. Sau đó thay mã ảnh bằng BASE64 thật, bỏ `image_files` rồi gửi API hiện tại. BASE64 thật/URL ảnh công khai từ luồng cũ vẫn tương thích. Không gửi `linkN`, TXT hay sandbox trực tiếp lên API; thiếu/hỏng file thì dừng trước POST, không lấy ảnh của lượt khác. Trên ChatGPT, nếu thẻ file không có URL tải trực tiếp, tiện ích mở bản xem trước TXT đúng tên rồi tự đóng; hãy đóng trình xem file khác đang mở trước khi chạy. Provider không cung cấp link/thẻ file đọc được sẽ báo lỗi khả năng thay vì tự bịa ảnh.

Sau khi cập nhật, Reload tiện ích trong `chrome://extensions`, tải lại tab AI và lấy prompt Cẩm nang mới. Không gỡ cài đặt/xoá dữ liệu hàng đợi.

Nếu trình xem TXT chưa đọc đủ file sau 20 giây, tiện ích tự đóng trình xem do nó mở, chờ 1,5 giây rồi tìm lại đúng thẻ file trong cùng câu trả lời và mở thêm một lần. Lỗi mạng hoặc HTTP tạm thời khi tải TXT cũng được thử lại một lần với link hiện tại. Panel thông báo lượt thử lại; sau hai lần vẫn lỗi thì dừng trước khi gửi website. Bấm Dừng sẽ huỷ việc thử lại; file sai hash/bytes, link không an toàn hoặc trình xem đã chuyển sang file khác vẫn dừng ngay.

## Viết hồ sơ bác sĩ

Lỗi tải danh sách khác với HTTP 200 `items=[]`: HTTP 503/schema chưa sẵn sàng hiển thị đầy đủ lỗi, trạng thái **Không tải được hồ sơ**, hướng dẫn quản trị và nút **Thử lại**. Nút Chạy bị chặn riêng nguồn bác sĩ của tab đó; không tự retry dồn dập khi mở lại panel, không chuyển sang cơ sở/nguồn khác. JSON, prompt, token/biên nhận và kết quả cũ vẫn được giữ. Khi API sẵn sàng, bấm Thử lại để tải lại danh sách rồi Chạy; hồ sơ đã lưu không tự viết đè.

503 có thể do DB/schema/bản deploy; tiện ích không khẳng định thiếu migration là nguyên nhân duy nhất. Quản trị cần kiểm tra log và, sau deploy, chạy CLI `php scripts/migrate_doctor_content.php` trên đúng DB server để cập nhật schema/prompt. Không chạy migration qua HTTP hay từ tiện ích. Prompt/output_template mới của server được dùng nguyên vẹn, gồm 11 trường Hồ sơ & pháp lý và `practice_license_json` cũ; không suy đoán dữ liệu thiếu hay tự verified. Lỗi 401/403/503 ở heartbeat hoặc API nhận (kể cả phản hồi không phải JSON) cũng dừng riêng luồng bác sĩ, giữ kết quả và mã yêu cầu để kiểm tra lại.

Chọn **Viết hồ sơ bác sĩ**, bấm **Tải lại** rồi **Chạy** trên tab AI. Đây là nguồn nghiên cứu tiếng Việt riêng, không phải **Dịch Việt → Anh → Bác sĩ**. Trước mỗi lượt, tiện ích kiểm tra lại điều kiện từ API và lấy prompt/output_template mới, không dùng prompt chung hoặc bản cache cũ. Bác sĩ phải là bản tiếng Việt đã xuất bản, chưa có nội dung và chưa được nghiên cứu.

Tiện ích xin khóa `type=doctor` trước khi gửi AI, giữ nguyên `request_id` và danh tính worker khi thử lại, gia hạn khóa mỗi 45 giây trong lúc viết hoặc gửi. Bác sĩ đã có nội dung, chưa xuất bản hoặc đang được phiên khác khóa sẽ không nhận prompt trùng. Token và API key không được đưa vào prompt.

AI phải trả đúng một JSON object trong một code block, `id` là số nguyên dương đúng ID bác sĩ, `name` giữ nguyên chính xác. Tiện ích kiểm tra đầy đủ các khóa `output_template`, giữ arrays/objects/null/trường mới, không cho AI sửa slug, trạng thái, điểm đánh giá, xác minh hoặc các trường vận hành. Chỉ POST tới API bác sĩ dưới dạng `{items:[{...JSON_AI,writer_claim_token:token}]}`, không gửi nhầm sang API cơ sở. Hồ sơ lưu với trạng thái chưa duyệt. `insufficient_data=true` kèm ghi chú biên tập là một nghiên cứu hoàn tất, không phải lỗi để tự viết lại.

Trước POST, URL gốc và các khóa `url`/`website_url`/`booking_url` trong các trường JSON của hợp đồng bác sĩ được kiểm tra đúng kiểu HTTP(S), giới hạn độ dài và không chứa thông tin đăng nhập. URL tùy chọn cho phép null; URL trong gallery, sources, social và video phải là chuỗi không rỗng. Object/mảng/số/boolean/Markdown sai kiểu sẽ bị chặn với đường dẫn cụ thể như `gallery_json[0].url`, không tự chuyển kiểu hay chọn một URL thay thế. JSON và phản hồi gốc vẫn được lưu; bấm biểu tượng lỗi để xem hướng dẫn sửa bằng AI. Hướng dẫn không tự gửi prompt khi AI đang viết, không thêm token/khóa API; gửi lại JSON chưa sửa vẫn bị chặn.

Riêng `social_links_json`, API hỗ trợ thêm danh sách `[{platform:"Tên nền tảng",url:"https://..."}]`. Tiện ích chuyển đúng dạng này thành object nền tảng:URL **chỉ ở payload gửi**, không sửa JSON/ phản hồi AI gốc đã lưu. Tên nền tảng chỉ bỏ khoảng trắng ngoài, không suy đoán nhãn như facebook/website. Tên trống/trùng, URL sai, object có trường bổ sung hoặc nhiều URL không rõ ràng đều bị chặn, không ghi đè hay bỏ chứng cứ. Object canonical và các trường khác được giữ nguyên; Gửi lại cũng dùng cùng bước kiểm tra/chuyển đổi này.

Nếu mất phản hồi POST, JSON và mã yêu cầu được lưu bền vững. Tiện ích kiểm tra `doctor-content.php?id=...` khi khởi động, mỗi phút và trước khi gửi lại; chỉ xác nhận thành công khi `last_researched_at` có giá trị và `full_json.writer_request_id` trùng lượt của mình. Trong khi chưa xác nhận, không chuyển sang bác sĩ khác. Biên nhận của phiên khác không được tính là thành công. JSON được giữ nếu mất khóa, nhưng không gửi dữ liệu cũ dưới một khóa khác. HTTP 401/403/503 dừng riêng worker bác sĩ và hiển thị lỗi để sửa cấu hình/backend.

Nút **Dừng** không hủy một POST bác sĩ đã gửi: tiện ích tiếp tục kiểm tra biên nhận của lượt đó, nhưng không chạy bài tiếp theo. Hồ sơ đã lưu thành công không có nút gửi lại để tránh viết đè.

## Fix ảnh cơ sở y tế

Chọn nguồn **Fix ảnh cơ sở y tế**, bấm **Tải lại** rồi **Chạy** trên tab AI. Luồng này kiểm tra/xóa/bổ sung ảnh thật, không tạo ảnh AI, không thay content, giá hoặc đánh giá. Cơ sở đã có bài viết vẫn được nhận. Danh sách hiển thị số ảnh và máy đang giữ cơ sở; kết quả và retry tách theo tab/nguồn.

Tiện ích giữ khóa `type=facility`, `client.task=facility_image_fix` chung với luồng viết cơ sở. Chỉ sau khi claim thành công mới GET lại `?ids=ID` (giữ `language=en` nếu là bản EN) để nhận ảnh, revision và prompt mới nhất. Dùng nguyên `item.prompt`, không dựng prompt chung. Prompt API ưu tiên ảnh thật của đúng chi nhánh trên Google Maps, website chính thức là nguồn dự phòng. Heartbeat mỗi 45 giây; backend mới cấp lease Fix ảnh 600 giây (viết bài vẫn 180 giây). Deadline dựa trên `server_now/lease_seconds` trừ RTT, không so sánh giờ máy tuyệt đối. Heartbeat xác nhận cùng token trước POST mới; retry biên nhận giữ nguyên token/payload gốc, không claim mới. Token/API key không đưa vào AI.

JSON phải nằm trong một code block, đúng ID số và `images_revision`, đánh giá mọi URL nguồn đúng một lần. Chặn xóa do HTTP 401/403/408/429/5xx hoặc lỗi truy cập chưa chắc chắn; HTTP 404/410 có bằng chứng được nhận. Ảnh bổ sung phải là URL HTTP(S) công khai có `source/source_url`; `angle/caption` tùy chọn. Giữ nguyên query string, không tự chế URL Google hay sửa revision. Bìa nguồn đã remove được gửi nguyên để backend tự chọn bìa gallery còn lại trong transaction.

Kết quả có quyết định `remove` hợp lệ được nhận và gửi cập nhật ngay sang website mà không bắt buộc phải đủ 5 ảnh thật đã xác minh; các cơ sở chỉ có 1–4 ảnh thật (hoặc chưa tìm thêm được ảnh thay thế) vẫn được lưu kết quả và cập nhật xóa ảnh lỗi ngay lập tức. Các bài từng bị chặn bởi quy tắc 5 ảnh cũ tự động mở khóa nút **Gửi lại** để lấy lại quyền giữ cơ sở và gửi JSON đã có mà không cần chạy AI lại.

`ai_image_url` trống có thể được AI trả là `null` hoặc `""`; tiện ích chuẩn hóa thành `""` trong payload mà không sửa JSON AI đã lưu. Nếu nguồn đang có URL ảnh, phải giữ nguyên hoặc chỉ xóa sau khi chính URL đó có quyết định `remove` kèm bằng chứng. Không dùng trường này để gán ảnh thật mới; ảnh bổ sung nằm trong `added_images`, ảnh đại diện chọn qua `image_url`. Payload/token đã gửi vẫn được giữ nguyên từng byte khi retry.

POST một mục `{items:[{...JSON_AI,writer_claim_token:token}]}` tới receiver Fix ảnh. Website tải và lưu ảnh ngay trong request, không chờ worker. Tiện ích không đặt timeout POST và hiển thị **Website đang tải/lưu ảnh** kèm thời gian chờ. Proxy/server vẫn có thể ngắt kết nối; khi đó biên nhận gốc được giữ để gửi lại. Claim có thể được server trả ngay sau khi commit JSON, trước lúc tải ảnh; heartbeat mất lease trong POST đang chạy không hủy lượt đó. Bấm Dừng chỉ ngăn bài tiếp theo, không hủy/release request đang lưu.

Chỉ xác nhận mục đúng ID trong `updated[]`, kể cả HTTP 207; `ok=true` chỉ nghĩa JSON đã lưu. Đọc `image_processing`, `images_imported`, `images_failed`, `image_results` của chính mục đó. **completed** hiển thị số ảnh lưu, không có nút gửi lại. **partial/not_started** hoặc còn ảnh lỗi được giữ ở trạng thái **ảnh chưa đủ**, không báo thành công toàn bộ và không bị xóa theo giới hạn lịch sử. Nhấn số ảnh lỗi để xem URL/lý do; **Gửi lại** POST đúng nguyên payload/token cũ để tải ảnh còn thiếu, không chạy AI/claim/GET nguồn mới và không thay revision gốc bằng revision server trả. Tương thích API cũ `queued` vẫn hiển thị Chờ worker, không nhận nhầm là ảnh đã tải.

HTTP 422 giữ JSON và khóa để gửi lại; bấm Dừng sẽ trả khóa nếu chưa có POST đang chạy. Sau `images_changed`/`lease_lost` đã xác nhận từ receiver, chọn **Kiểm tra lại** rồi **Chạy** để nghiên cứu nguồn mới, không gửi kết quả cũ dưới khóa mới. Nếu mất phản hồi POST, **Gửi lại** dùng đúng payload/token đã lưu để API nhận diện `already_processed`; không claim hay GET nguồn mới trước retry. Kết quả partial vẫn được gửi lại sau khi Dừng hoặc reload tiện ích.

Queue giữ các tham số cấu hình `only_pending`, `recheck_days`, `target_images`, `page`, `after_id`, `language`; tự đi tiếp theo `next_after_id`. Tải lại chỉ cập nhật snapshot bài chờ, không đổi nguồn bài đang chạy/đã xong. Lỗi gallery từ `errors` được hiển thị, không coi API 404/503 là danh sách rỗng.

**Triển khai backend riêng:** hai API Fix ảnh cần bản backend tải ảnh đồng bộ và migration `php scripts/migrate_facility_image_fix.php` trước khi chạy thật. Fix ảnh không cần cron worker; các luồng media khác vẫn theo cấu hình website. Bản extension này chỉ kiểm thử mock/local; không deploy, không gửi AI/POST hay sửa ảnh hồ sơ thật trong quá trình kiểm thử.

## Khóa API riêng cho từng bản cài

Trước khi Load unpacked bản tải từ Git, sao chép `api-key.example.js` thành `api-key.local.js` trong thư mục tiện ích rồi đặt khóa API riêng vào `globalThis.MEDREVIEW_MEDICAL_API_KEY`. File `.local.js` đã được Git ignore, không đẩy lên repo. Service worker đọc file này khi khởi động; không có khóa mặc định trong source. Sau khi thay khóa, reload tiện ích. Bản đang cài trên Desktop đã giữ cấu hình riêng cục bộ. Khi đóng gói/chia sẻ tiện ích, không kèm file chứa khóa này.

## Dịch Việt → Anh

Chọn **Dịch Việt → Anh**, rồi chọn loại dữ liệu **Cơ sở y tế**, **Bác sĩ** hoặc **Toplist**. Extension gửi `GET translate-content.php?page=1&limit=1&type=<type>` với API key để xử lý từng bản ghi một. API trả toàn bộ hàng tiếng Việt trong `source`, prompt dịch đã ghép đúng bản ghi từ mục Prompt AI, danh sách trường và `output_template`. Extension đưa nguyên prompt đó cho AI, không tự thêm hướng dẫn dịch chung làm mất dữ liệu/ngữ cảnh hoặc xung đột định dạng.

AI phải trả về envelope `{ "type": "facility", "source_id": 53, "translated": { ...mọi khóa trong output_template... } }`. Extension kiểm tra `type`, `source_id`, toàn bộ khóa template và không cho phép trường thừa trước khi POST; bản dịch sai/thiếu vẫn được giữ trong tiện ích để sửa hoặc gửi lại. Khi hợp lệ, tiện ích POST tới cùng URL với body `{ "type": "facility", "items": [{ "source_id": 53, "translated": { ... } }] }`. Kết quả thành công hiển thị trạng thái đã lưu bản dịch nháp, slug và các trường server xác nhận. Nút **Gửi lại** dùng lại type/source_id gốc và JSON đã lưu, không đi qua endpoint cập nhật nội dung cơ sở hay Toplist.

## Danh sách bác sĩ/cơ sở cho Toplist

Nguồn **Toplist** nhận cả ba loại: `facility` với `facilities`, `doctor` với `doctors` (alias `bac_si`), và `mixed` với `members` có `type=facility/doctor` hoặc hai mảng `facilities` + `doctors`. ID cơ sở/bác sĩ bên trong danh sách không phải ID bài `toplist_id`; cả hai loại dùng chung thứ tự `rank_order`. Giữ nguyên JSON và metadata khi gửi/gửi lại. Tiện ích kiểm tra đúng ID, đúng `entity_type`, danh sách không rỗng và thông tin nhận diện bác sĩ mới trước khi POST; không tự đổi loại bài hoặc trộn hồ sơ.

API tự dùng prompt **Danh sách bác sĩ cho Toplist** (`toplist_doctor`) trong quản trị khi bài là `doctor`; tiện ích gửi nguyên prompt đó, không dùng prompt nghiên cứu hồ sơ bác sĩ đơn lẻ. Kết quả phải trong block code json. Bài không có prompt sẽ không vào hàng đợi. JSON chưa đủ dữ liệu vẫn được giữ để xử lý lỗi, không bịa hồ sơ dự phòng.

URL mặc định cũ `toplists-needing-facilities.php`/`toplist-facilities-update.php` trên MedReview tự chuyển sang API members khi khởi động, kể cả cấu hình riêng từng tab, giữ tham số lọc/page và lịch sử bài. URL API tùy chỉnh bên ngoài không bị thay đổi. Sau khi cập nhật, Reload tiện ích rồi tải lại tab AI và bấm Tải lại ở nguồn Toplist để nạp prompt mới.

## Tạo ảnh AI

Chọn **Tạo ảnh AI** trong nguồn tác vụ. Mặc định tiện ích gọi:

- `GET https://medreview.vn/api/medical/facilities-needing-ai-images.php?page=1&limit=1&min_images=3`
- `POST https://medreview.vn/api/medical/facility-ai-image-update.php`

API danh sách chọn cơ sở có `gallery_json` từ 3 ảnh trở lên và gửi tối đa 4 ảnh tham chiếu trong dữ liệu/prompt. Mặc định endpoint bỏ qua cơ sở đã có ảnh AI để tránh tạo lặp; thêm `only_missing=0` trong Cài đặt nếu muốn tạo lại cả cơ sở đã có ảnh AI.

Luồng tạo ảnh dùng **ChatGPT** hoặc **Grok**: tiện ích gửi prompt từ API để AI trả về JSON `image_prompt`, gửi chính `image_prompt` đó ở lượt thứ hai để AI tạo ảnh, rồi lấy ảnh hoàn tất. Khi ảnh xuất hiện, tiện ích tải ảnh thành `Blob` ngay trong tab AI đang đăng nhập và upload file bằng `multipart/form-data` tới website. Server lưu file vào thư mục riêng của cơ sở và cập nhật `ai_image_url` bằng đường dẫn nội bộ; URL private/tạm thời của ChatGPT hoặc Grok không được lưu vào DB. Tiện ích không gửi `set_as_cover`, nên không đè ảnh bìa gốc. Claude và Gemini vẫn dùng cho luồng bài viết/Toplist, chưa dùng để tạo ảnh.

Với Gemini Spark, extension chỉ kiểm tra nút Stop mỗi giây; khi nút biến mất mới đọc và xác minh JSON. Nếu Stop vẫn hiện sau hai phút, tab được tải lại và recovery tiếp tục theo dõi task. Khi Spark dừng nhưng JSON không hợp lệ hoặc không khớp ID bài, extension gửi lại prompt gốc một lần cho đúng bài đó. Nếu lần gửi lại vẫn không hợp lệ, bài được giữ để xử lý lỗi thay vì tiếp tục lặp vô hạn.

Khi AI viết xong và website xác nhận cập nhật, bài **hoàn tất** tự ẩn khỏi **Danh sách bài** nhưng JSON và lịch sử gửi vẫn được giữ ở các mục bên dưới. Khi hết bài chờ, tiện ích tự gọi lại API của nguồn đã chọn và chạy tiếp lô mới. Nếu API trả rỗng hoặc chỉ có ID đã xử lý, hàng đợi dừng sạch, không tải lặp vô hạn.

Tiện ích đọc JSON trong khối mã và nội dung trả lời trực tiếp, kể cả khi có lời dẫn hoặc nguồn tham khảo bên ngoài. Nếu có nhiều khối, tiện ích ưu tiên JSON đầy đủ khớp ID bài đang viết. Các trường `reviews` và trường mới được giữ nguyên khi gửi API.

Chỉ nhận kết quả khi phản hồi mới đã ổn định, AI ngừng viết và JSON hợp lệ. Bài đọc thiếu hoặc sai JSON tiếp tục chờ tối đa 30 phút; sau đó hiển thị lỗi và giữ nội dung đọc được trong bộ nhớ tiện ích, không tạo bài dự phòng từ văn bản lỗi. Bấm biểu tượng lỗi trong **Trạng thái gửi website** để xem lý do. Kết quả lỗi được lưu bằng phiên bản cũ cần lấy lại trước khi gửi.

Sau khi cập nhật các file, Reload tiện ích trong `chrome://extensions` và tải lại tab AI để nạp bộ đọc mới.

Kiểm thử cục bộ: `node --test tests/*.test.cjs`. Các bài kiểm tra dùng dữ liệu mô phỏng, không gửi prompt hay gọi API thật.

## Lưu ý

- Website AI thường thay đổi giao diện; selector trong `content.js` có thể cần chỉnh cho phù hợp.
- Tiện ích chỉ chạy khi bạn đã đăng nhập và mở tab đúng nhà cung cấp. Nếu vừa reload extension, tiện ích sẽ tự nạp lại phần điều khiển vào tab AI.
- Mỗi AI xử lý lần lượt phần bài đã được khóa riêng cho nó. Các kết quả hoàn tất cùng lúc được ghi độc lập; kết quả chỉ được đánh dấu hoàn tất sau khi API cập nhật thành công.
