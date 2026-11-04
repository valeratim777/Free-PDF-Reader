package io.github.valeratim777.pdfreader;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * "Read aloud" in the Android app: the phone's own speech engine (usually Google's,
 * with natural voices for many languages). The web view has no speech of its own.
 */
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin {

    private TextToSpeech tts;
    private Boolean ready = null;
    private final List<Runnable> waiting = new ArrayList<>();
    private final Map<String, PluginCall> speaking = new ConcurrentHashMap<>();

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            List<Runnable> run;
            synchronized (this) {
                ready = status == TextToSpeech.SUCCESS;
                run = new ArrayList<>(waiting);
                waiting.clear();
            }
            for (Runnable r : run) r.run();
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String id) {}

            @Override
            public void onDone(String id) {
                PluginCall call = speaking.remove(id);
                if (call != null) call.resolve();
            }

            @Override
            public void onError(String id) {
                PluginCall call = speaking.remove(id);
                if (call != null) call.reject("speech error");
            }

            @Override
            public void onError(String id, int code) {
                PluginCall call = speaking.remove(id);
                if (call != null) call.reject("speech error " + code);
            }

            @Override
            public void onStop(String id, boolean interrupted) {
                PluginCall call = speaking.remove(id);
                if (call != null) {
                    JSObject r = new JSObject();
                    r.put("interrupted", true);
                    call.resolve(r);
                }
            }
        });
    }

    /** Runs `r` once the engine has started (it starts asynchronously). */
    private void whenReady(PluginCall call, Runnable r) {
        synchronized (this) {
            if (ready == null) {
                waiting.add(() -> whenReady(call, r));
                return;
            }
        }
        if (!ready) call.reject("No speech engine on this device");
        else r.run();
    }

    @PluginMethod
    public void voices(PluginCall call) {
        whenReady(call, () -> {
            String lang = call.getString("lang", "");
            JSArray list = new JSArray();
            Set<Voice> all = tts.getVoices();
            if (all != null) {
                for (Voice v : all) {
                    if (!v.getLocale().getLanguage().equals(new Locale(lang).getLanguage())) continue;
                    Set<String> features = v.getFeatures();
                    if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    JSObject o = new JSObject();
                    o.put("id", v.getName());
                    o.put("locale", v.getLocale().toLanguageTag());
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("quality", v.getQuality());
                    list.put(o);
                }
            }
            JSObject r = new JSObject();
            r.put("voices", list);
            Voice def = tts.getDefaultVoice();
            if (def != null) r.put("default", def.getName());
            call.resolve(r);
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        whenReady(call, () -> {
            String text = call.getString("text", "");
            String lang = call.getString("lang", "");
            String voice = call.getString("voice", "");
            Float rate = call.getFloat("rate", 1f);
            boolean set = false;
            if (voice != null && !voice.isEmpty() && tts.getVoices() != null) {
                for (Voice v : tts.getVoices()) {
                    if (v.getName().equals(voice)) {
                        set = tts.setVoice(v) == TextToSpeech.SUCCESS;
                        break;
                    }
                }
            }
            if (!set && lang != null && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate(rate == null ? 1f : rate);
            String id = UUID.randomUUID().toString();
            speaking.put(id, call);
            if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id) != TextToSpeech.SUCCESS) {
                speaking.remove(id);
                call.reject("speech failed");
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        // Utterances that were waiting end as interrupted.
        for (String id : speaking.keySet()) {
            PluginCall c = speaking.remove(id);
            if (c != null) {
                JSObject r = new JSObject();
                r.put("interrupted", true);
                c.resolve(r);
            }
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        tts = null;
    }
}
