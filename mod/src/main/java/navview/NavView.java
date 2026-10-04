package navview;

import net.minecraft.client.settings.KeyBinding;
import net.minecraftforge.client.ClientCommandHandler;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.config.Configuration;
import net.minecraftforge.fml.client.registry.ClientRegistry;
import net.minecraftforge.fml.common.FMLCommonHandler;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.event.FMLPreInitializationEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.InputEvent;
import org.lwjgl.input.Keyboard;

@Mod(modid = NavView.MODID, name = "Nav View", version = NavView.VERSION, clientSideOnly = true)
public class NavView {
    public static final String MODID = "navview";
    public static final String VERSION = "1.0.0";

    public static KeyBinding toggleKey;
    public static boolean enabled = true;
    public static String host = "127.0.0.1";
    public static int port = 28765;

    private static PathClient client;

    @Mod.EventHandler
    public void preInit (FMLPreInitializationEvent event) {
        Configuration config = new Configuration(event.getSuggestedConfigurationFile());
        config.load();
        host = config.getString("host", "connection", "127.0.0.1", "Debug server address. This mod only dials localhost.");
        port = config.getInt("port", "connection", 28765, 1, 65535, "Debug server port.");
        if (config.hasChanged()) config.save();
    }

    @Mod.EventHandler
    public void init (FMLInitializationEvent event) {
        toggleKey = new KeyBinding("key.navview.toggle", Keyboard.KEY_V, "key.categories.navview");
        ClientRegistry.registerKeyBinding(toggleKey);
        ClientCommandHandler.instance.registerCommand(new CommandNavView());
        MinecraftForge.EVENT_BUS.register(this);
        MinecraftForge.EVENT_BUS.register(new PathRenderer());
        FMLCommonHandler.instance().bus().register(this);
        client = new PathClient();
        client.start();
    }

    public static PathClient client () {
        return client;
    }

    public static void toggle () {
        enabled = !enabled;
        PathClient.chat(enabled ? "overlay on" : "overlay off");
    }

    public static void reconnect () {
        if (client != null) client.reconnect();
    }

    @SubscribeEvent
    public void onKey (InputEvent.KeyInputEvent event) {
        if (toggleKey != null && toggleKey.isPressed()) toggle();
    }
}
