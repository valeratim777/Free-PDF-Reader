package io.github.valeratim777.pdfreader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins: installing updates, reading aloud.
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(SpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
