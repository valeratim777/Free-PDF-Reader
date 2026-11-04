package io.github.valeratim777.pdfreader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin: installing updates from inside the app.
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
