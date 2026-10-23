package com.codenotes.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 原生文件夹选择：用 SAF(ACTION_OPEN_DOCUMENT_TREE) 选目录，
 * 递归读出文件并以 base64 交给网页层，绕开 WebView 不支持选文件夹的问题。
 */
@CapacitorPlugin(name = "DirPicker")
public class DirPickerPlugin extends Plugin {

    private static final long MAX_TOTAL = 30L * 1024 * 1024; // 最多 30MB
    private static final int MAX_FILES = 3000;
    private String pendingText = null;

    /** 应用数据目录（给设置页展示用） */
    @PluginMethod
    public void dataDir(PluginCall call) {
        JSObject res = new JSObject();
        res.put("dir", getContext().getDataDir().getAbsolutePath());
        res.put("webview", getContext().getDataDir().getAbsolutePath() + "/app_webview");
        call.resolve(res);
    }

    /** 导出文本到用户选择的位置（SAF 创建文档） */
    @PluginMethod
    public void saveText(PluginCall call) {
        pendingText = call.getString("content", "");
        String name = call.getString("name", "codenotes-backup.json");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "onSavePicked");
    }

    @ActivityCallback
    private void onSavePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            pendingText = null;
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new Exception("no stream");
            os.write((pendingText == null ? "" : pendingText).getBytes(StandardCharsets.UTF_8));
            os.flush();
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("写入失败：" + e.getMessage());
        } finally {
            pendingText = null;
        }
    }

    /** 从用户选择的位置读取文本 */
    @PluginMethod
    public void openText(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "onOpenPicked");
    }

    @ActivityCallback
    private void onOpenPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("no stream");
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            JSObject res = new JSObject();
            res.put("text", buf.toString(StandardCharsets.UTF_8.name()));
            call.resolve(res);
        } catch (Exception e) {
            call.reject("读取失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "onTreePicked");
    }

    @ActivityCallback
    private void onTreePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        final Uri treeUri = result.getData().getData();
        new Thread(() -> {
            try {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), treeUri);
                if (root == null) {
                    call.reject("无法读取这个文件夹");
                    return;
                }
                String name = root.getName() != null ? root.getName() : "文件夹";
                JSArray files = new JSArray();
                long[] total = { 0 };
                int[] count = { 0 };
                walk(root, "", files, total, count);

                JSObject res = new JSObject();
                res.put("name", name);
                res.put("files", files);
                res.put("truncated", total[0] >= MAX_TOTAL || count[0] >= MAX_FILES);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "读取目录失败" : e.getMessage());
            }
        }).start();
    }

    private void walk(DocumentFile dir, String prefix, JSArray out, long[] total, int[] count) {
        DocumentFile[] children;
        try {
            children = dir.listFiles();
        } catch (Exception e) {
            return;
        }
        if (children == null) return;

        for (DocumentFile f : children) {
            if (total[0] >= MAX_TOTAL || count[0] >= MAX_FILES) return;
            String name;
            try {
                name = f.getName();
            } catch (Exception e) {
                continue;
            }
            if (name == null || name.startsWith(".") || name.equals("node_modules")) continue;

            String path = prefix.isEmpty() ? name : prefix + "/" + name;
            if (f.isDirectory()) {
                walk(f, path, out, total, count);
                continue;
            }
            try (InputStream in = getContext().getContentResolver().openInputStream(f.getUri())) {
                if (in == null) continue;
                byte[] bytes = readAll(in, MAX_TOTAL - total[0]);
                if (bytes == null || bytes.length == 0) continue;
                total[0] += bytes.length;
                count[0]++;
                JSObject o = new JSObject();
                o.put("p", path);
                o.put("d", Base64.encodeToString(bytes, Base64.NO_WRAP));
                out.put(o);
            } catch (Exception ignored) {
                // 单个文件读失败就跳过
            }
        }
    }

    private byte[] readAll(InputStream in, long limit) {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[16 * 1024];
        long total = 0;
        try {
            int n;
            while ((n = in.read(chunk)) > 0) {
                if (total + n > limit) {
                    int allowed = (int) Math.max(0, limit - total);
                    if (allowed > 0) buf.write(chunk, 0, allowed);
                    break;
                }
                buf.write(chunk, 0, n);
                total += n;
            }
        } catch (Exception e) {
            return null;
        }
        return buf.toByteArray();
    }
}
