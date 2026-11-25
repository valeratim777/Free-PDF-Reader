package io.github.valeratim777.pdfreader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins: installing updates from inside the app; files from and to other apps.
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(FilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
